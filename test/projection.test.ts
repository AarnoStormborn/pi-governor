import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cacheHitRate,
  describeUnpricedModel,
  estimateTurnCost,
  isUnpriced,
  type CostRates,
} from "../src/projection.ts";

/** Rates for commandcode/deepseek-v4-flash, taken from the provider's table. */
const FLASH: CostRates = { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 };
const FREE: CostRates = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const OPUS: CostRates = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };

describe("isUnpriced", () => {
  it("flags all-zero rate tables", () => {
    assert.equal(isUnpriced(FREE), true);
  });

  it("treats a missing table as unpriced", () => {
    assert.equal(isUnpriced(undefined), true);
    assert.equal(isUnpriced(null), true);
  });

  it("accepts any table with at least one non-zero rate", () => {
    assert.equal(isUnpriced(FLASH), false);
    assert.equal(isUnpriced({ input: 0, output: 0, cacheRead: 0.01, cacheWrite: 0 }), false);
  });

  it("ignores non-numeric junk", () => {
    assert.equal(isUnpriced({ input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0 } as CostRates), true);
  });
});

describe("cacheHitRate", () => {
  it("returns the cache-read share of input tokens", () => {
    assert.equal(cacheHitRate({ input: 20, cacheRead: 80 }), 0.8);
  });

  it("returns null with no input history", () => {
    assert.equal(cacheHitRate({ input: 0, cacheRead: 0 }), null);
    assert.equal(cacheHitRate(undefined), null);
  });

  it("clamps to the unit interval", () => {
    assert.equal(cacheHitRate({ input: -10, cacheRead: 110 }), 1);
  });
});

describe("estimateTurnCost", () => {
  const base = { contextTokens: 1_000_000, cacheHitRate: null, assumedOutputTokens: 1000, useCacheEstimate: false };

  it("returns null for unpriced models so 'free' is distinguishable from 'unknown'", () => {
    assert.equal(estimateTurnCost(base, FREE), null);
    assert.equal(estimateTurnCost(base, undefined), null);
  });

  it("returns null when the context size is unknown", () => {
    assert.equal(estimateTurnCost({ ...base, contextTokens: null }, FLASH), null);
    assert.equal(estimateTurnCost({ ...base, contextTokens: 0 }, FLASH), null);
  });

  it("prices the whole context at the input rate without a cache estimate", () => {
    const estimate = estimateTurnCost(base, FLASH);
    assert.ok(estimate);
    // 1M input tokens at $0.22/M, 1k output at $0.66/M.
    assert.ok(Math.abs(estimate.inputCost - 0.22) < 1e-9);
    assert.ok(Math.abs(estimate.outputCost - 0.00066) < 1e-9);
    assert.equal(estimate.usedCacheEstimate, false);
  });

  it("splits the context by cache hit rate when estimating from cache", () => {
    const estimate = estimateTurnCost({ ...base, cacheHitRate: 0.9, useCacheEstimate: true }, FLASH);
    assert.ok(estimate);
    // 900k cached at $0.007/M + 100k fresh at $0.22/M.
    assert.ok(Math.abs(estimate.inputCost - (0.9 * 0.007 + 0.1 * 0.22)) < 1e-9);
    assert.equal(estimate.usedCacheEstimate, true);
  });

  it("is dramatically cheaper when the cache is warm — the whole point of the estimate", () => {
    const warm = estimateTurnCost({ ...base, cacheHitRate: 0.98, useCacheEstimate: true }, FLASH);
    const cold = estimateTurnCost({ ...base, cacheHitRate: 0.98, useCacheEstimate: false }, FLASH);
    assert.ok(warm && cold);
    assert.ok(warm.total < cold.total / 10, `${warm.total} should be far below ${cold.total}`);
  });

  it("falls back to a cold cache when no hit rate is known", () => {
    const estimate = estimateTurnCost({ ...base, useCacheEstimate: true }, FLASH);
    assert.ok(estimate);
    assert.equal(estimate.usedCacheEstimate, false);
    assert.ok(Math.abs(estimate.inputCost - 0.22) < 1e-9);
  });

  it("exposes the overshoot problem it exists to solve", () => {
    // 500k context + 65.5k max output on Opus.
    const estimate = estimateTurnCost(
      { contextTokens: 500_000, cacheHitRate: null, assumedOutputTokens: 65_536, useCacheEstimate: false },
      OPUS,
    );
    assert.ok(estimate);
    assert.ok(estimate.total > 12, `expected ~$12.42, got $${estimate.total.toFixed(2)}`);
    assert.ok(estimate.total < 12.5);
  });

  it("treats a negative output assumption as zero", () => {
    const estimate = estimateTurnCost({ ...base, assumedOutputTokens: -5000 }, FLASH);
    assert.ok(estimate);
    assert.equal(estimate.outputCost, 0);
  });

  it("totals input and output", () => {
    const estimate = estimateTurnCost(base, FLASH);
    assert.ok(estimate);
    assert.ok(Math.abs(estimate.total - (estimate.inputCost + estimate.outputCost)) < 1e-12);
  });
});

describe("describeUnpricedModel", () => {
  it("names the model and suggests alternatives", () => {
    const message = describeUnpricedModel("commandcode", "some/new-model");
    assert.match(message, /commandcode\/some\/new-model/);
    assert.match(message, /no pricing data/);
    assert.match(message, /time, context, tokens, or turns/);
  });
});
