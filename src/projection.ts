/**
 * Cost projection and pricing sanity checks.
 *
 * Pi computes cost locally from token counts × a rate table (pi-ai's
 * `calculateCost`), and it does so at stream end. Two consequences drive this
 * module:
 *
 *   1. `cost.total` is 0 whenever the active model has no pricing data, so a
 *      cost limit silently never fires. `isUnpriced()` detects that.
 *   2. Cost is only knowable after a turn is paid for, so a post-hoc limit
 *      always overshoots by up to one turn. `estimateTurnCost()` prices the
 *      next turn *before* it is spent, which is what makes a cost limit a
 *      guardrail rather than a report.
 *
 * Everything here is pure and unit tested without the pi runtime.
 */

export interface CostRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface UsageLike {
  input?: number;
  cacheRead?: number;
}

export interface EstimateInput {
  /** Exact context tokens for the next request, when known. */
  contextTokens: number | null;
  /** Observed cache-read share of input tokens, in [0, 1]. */
  cacheHitRate: number | null;
  /** How many output tokens to assume for the next turn. */
  assumedOutputTokens: number;
  /** Credit the observed cache hit rate instead of assuming a cold cache. */
  useCacheEstimate: boolean;
}

export interface TurnCostEstimate {
  inputCost: number;
  outputCost: number;
  total: number;
  /** True when the cache hit rate was used; false for a worst-case cold cache. */
  usedCacheEstimate: boolean;
}

/** Rates are per million tokens. */
const PER_MILLION = 1_000_000;

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * True when a model's rate table carries no usable pricing.
 *
 * Pi's own `calculateCost` multiplies by these rates, so an all-zero table
 * makes `usage.cost.total` permanently 0. Providers that build catalogs from a
 * hardcoded table plus a fallback (`MODEL_COSTS[id] ?? ZERO_MODEL_COST`) hand
 * out zero rates for every model they have not priced yet.
 */
export function isUnpriced(rates: CostRates | undefined | null): boolean {
  if (!rates) return true;
  return (
    finite(rates.input) === 0 &&
    finite(rates.output) === 0 &&
    finite(rates.cacheRead) === 0 &&
    finite(rates.cacheWrite) === 0
  );
}

/**
 * Share of input tokens that were served from the prompt cache.
 *
 * This matters more than volume: measured on a real session, `cacheRead` was
 * 31x cheaper than `input`, and 98% of input tokens were cache reads. Returns
 * null when there is no input history yet.
 */
export function cacheHitRate(usage: UsageLike | undefined | null): number | null {
  if (!usage) return null;
  const cacheRead = finite(usage.cacheRead);
  const fresh = finite(usage.input);
  const total = cacheRead + fresh;
  if (total <= 0) return null;
  return clamp01(cacheRead / total);
}

/**
 * Price the next turn before it happens.
 *
 * With `useCacheEstimate` the observed cache hit rate splits the context into
 * cache-read and full-price input; otherwise the whole context is priced at the
 * input rate, which is the conservative worst case for a cold cache.
 *
 * Returns null when the estimate cannot be made (no pricing, no token count),
 * so callers can distinguish "free" from "unknown".
 */
export function estimateTurnCost(input: EstimateInput, rates: CostRates | undefined | null): TurnCostEstimate | null {
  if (!rates || isUnpriced(rates)) return null;

  const contextTokens = input.contextTokens;
  if (contextTokens === null || !Number.isFinite(contextTokens) || contextTokens <= 0) return null;

  const assumedOutput = Math.max(0, finite(input.assumedOutputTokens));

  let inputCost: number;
  let usedCacheEstimate = false;

  if (input.useCacheEstimate && input.cacheHitRate !== null && Number.isFinite(input.cacheHitRate)) {
    const hitRate = clamp01(input.cacheHitRate);
    const cachedTokens = contextTokens * hitRate;
    const freshTokens = contextTokens - cachedTokens;
    inputCost =
      (cachedTokens * finite(rates.cacheRead)) / PER_MILLION + (freshTokens * finite(rates.input)) / PER_MILLION;
    usedCacheEstimate = true;
  } else {
    inputCost = (contextTokens * finite(rates.input)) / PER_MILLION;
  }

  const outputCost = (assumedOutput * finite(rates.output)) / PER_MILLION;

  return {
    inputCost,
    outputCost,
    total: inputCost + outputCost,
    usedCacheEstimate,
  };
}

/** Message explaining why a configured cost limit cannot fire on this model. */
export function describeUnpricedModel(provider: string, modelId: string): string {
  return (
    `⚖ cost limit cannot fire: ${provider}/${modelId} has no pricing data ` +
    `(all rates are 0), so spend is reported as $0.00. ` +
    `Set a limit on time, context, tokens, or turns instead, or price the model in models.json.`
  );
}
