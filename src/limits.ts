/**
 * Limit evaluation for pi-governor.
 *
 * Turns raw metrics into a per-limit verdict (`ok` / `warn` / `exceeded`) that
 * the UI and the enforcement layer both read from. Pure and unit tested.
 */

import { LIMIT_LABELS, LIMIT_KEYS, type GovernorConfig, type LimitKey } from "./types.ts";
import type { GovernorMetrics } from "./metrics.ts";

export type LimitStatus = "unset" | "unknown" | "ok" | "warn" | "exceeded";

export interface LimitState {
  key: LimitKey;
  status: LimitStatus;
  /** Current value in display units (ms for `time`, USD for `cost`, ...). */
  value: number | null;
  /** Configured limit in the same units, or null when unconfigured. */
  limit: number | null;
  /** `value / limit`, or null when either side is unknown. */
  ratio: number | null;
  /**
   * Value including the projected cost of the next turn, when pre-flight
   * estimation is available. Equal to `value` for non-cost limits.
   */
  projectedValue: number | null;
  /** Status derived from `projectedValue`, used by pre-flight enforcement. */
  projectedStatus: LimitStatus;
}

/** Cost of the next turn, estimated before it is spent. */
export interface CostProjection {
  /** Estimated cost of the upcoming turn. */
  turnCost: number;
  /** `usage.cost + turnCost`. */
  totalCost: number;
  /** True when the observed cache hit rate was used instead of a cold cache. */
  usedCacheEstimate: boolean;
}

const STATUS_RANK: Record<LimitStatus, number> = {
  unset: 0,
  unknown: 0,
  ok: 1,
  warn: 2,
  exceeded: 3,
};

/** The configured limit for a key, in display units (ms for `time`). */
export function limitFor(key: LimitKey, config: GovernorConfig): number | null {
  switch (key) {
    case "time":
      return config.limits.timeMinutes === null ? null : config.limits.timeMinutes * 60_000;
    case "cost":
      return config.limits.costUsd;
    case "context":
      return config.limits.contextPercent;
    case "tokens":
      return config.limits.totalTokens;
    case "turns":
      return config.limits.turns;
    default:
      return null;
  }
}

/** The observed value for a key, in the same units as `limitFor`. */
export function valueFor(key: LimitKey, metrics: GovernorMetrics, config: GovernorConfig): number | null {
  switch (key) {
    case "time":
      return config.timeMode === "active" ? metrics.activeMs : metrics.wallMs;
    case "cost":
      return metrics.usage.cost;
    case "context":
      return metrics.context?.percent ?? null;
    case "tokens":
      return metrics.usage.total;
    case "turns":
      return metrics.turns;
    default:
      return null;
  }
}

/** True when at least one budget is configured. */
export function hasAnyLimit(config: GovernorConfig): boolean {
  return LIMIT_KEYS.some((key) => limitFor(key, config) !== null);
}

export function classify(value: number | null, limit: number | null, warnRatio: number): LimitState["status"] {
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return "unset";
  if (value === null || !Number.isFinite(value)) return "unknown";
  const ratio = value / limit;
  if (ratio >= 1) return "exceeded";
  if (ratio >= warnRatio) return "warn";
  return "ok";
}

/** Evaluate every limit against the current metrics. */
export function evaluateLimits(
  metrics: GovernorMetrics,
  config: GovernorConfig,
  projection: CostProjection | null = null,
): LimitState[] {
  const warnRatio = Math.min(Math.max(config.warnRatio, 0.05), 1);

  return LIMIT_KEYS.map((key) => {
    const limit = limitFor(key, config);
    const value = valueFor(key, metrics, config);
    const status = classify(value, limit, warnRatio);
    const ratio = limit !== null && limit > 0 && value !== null && Number.isFinite(value) ? value / limit : null;

    // Only the cost limit can be projected forward.
    const projectedValue = key === "cost" && projection !== null ? projection.totalCost : value;
    const projectedStatus = key === "cost" && projection !== null && value !== null
      ? classify(projectedValue, limit, warnRatio)
      : status;

    return { key, status, value, limit, ratio, projectedValue, projectedStatus };
  });
}

/** The most severe status across all limits. */
export function overallStatus(states: readonly LimitState[]): LimitStatus {
  let worst: LimitStatus = "unset";
  for (const state of states) {
    if (STATUS_RANK[state.status] > STATUS_RANK[worst]) worst = state.status;
  }
  return worst;
}

/** Keys whose budget is currently exceeded. */
export function exceededKeys(states: readonly LimitState[]): LimitKey[] {
  return states.filter((state) => state.status === "exceeded").map((state) => state.key);
}

/**
 * Keys whose budget the *next* turn is projected to exceed.
 * Restricted to cost, which is the only forward-projectable metric.
 */
export function projectedOverspendKeys(states: readonly LimitState[]): LimitKey[] {
  return states
    .filter((state) => state.key === "cost" && state.projectedStatus === "exceeded" && state.status !== "exceeded")
    .map((state) => state.key);
}

export function describeLimit(key: LimitKey): string {
  return LIMIT_LABELS[key];
}
