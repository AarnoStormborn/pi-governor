import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import {
  classify,
  configuredKeys,
  describeState,
  evaluateLimits,
  exceededKeys,
  hasAnyLimit,
  limitFor,
  overallStatus,
  valueFor,
} from "../src/limits.ts";
import { emptyUsage, type GovernorMetrics } from "../src/metrics.ts";
import type { GovernorConfig } from "../src/types.ts";

function metrics(overrides: Partial<GovernorMetrics> = {}): GovernorMetrics {
  return {
    startedAt: 0,
    now: 0,
    wallMs: 0,
    activeMs: 0,
    turns: 0,
    toolCalls: 0,
    usage: emptyUsage(),
    context: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 },
    ...overrides,
  };
}

function configWith(patch: Parameters<typeof mergeConfig>[1]): GovernorConfig {
  return mergeConfig(DEFAULT_CONFIG, patch);
}

describe("limitFor", () => {
  it("converts minutes to milliseconds for the time limit", () => {
    const config = configWith({ limits: { timeMinutes: 90 } });
    assert.equal(limitFor("time", config), 5_400_000);
  });

  it("returns null for unconfigured limits", () => {
    assert.equal(limitFor("cost", DEFAULT_CONFIG), null);
  });
});

describe("valueFor", () => {
  it("uses wall time by default and active time when configured", () => {
    const sample = metrics({ wallMs: 60_000, activeMs: 20_000 });
    assert.equal(valueFor("time", sample, DEFAULT_CONFIG), 60_000);
    assert.equal(valueFor("time", sample, configWith({ timeMode: "active" })), 20_000);
  });

  it("reads cost, tokens and turns from the aggregate", () => {
    const sample = metrics({
      turns: 4,
      usage: { ...emptyUsage(), total: 1234, cost: 0.5 },
    });
    assert.equal(valueFor("cost", sample, DEFAULT_CONFIG), 0.5);
    assert.equal(valueFor("tokens", sample, DEFAULT_CONFIG), 1234);
    assert.equal(valueFor("turns", sample, DEFAULT_CONFIG), 4);
  });

  it("reports unknown context when the context window is unavailable", () => {
    assert.equal(valueFor("context", metrics({ context: null }), DEFAULT_CONFIG), null);
  });
});

describe("classify", () => {
  it("maps ratios onto statuses at the warn boundary", () => {
    assert.equal(classify(0, 100, 0.8), "ok");
    assert.equal(classify(79, 100, 0.8), "ok");
    assert.equal(classify(80, 100, 0.8), "warn");
    assert.equal(classify(100, 100, 0.8), "exceeded");
    assert.equal(classify(150, 100, 0.8), "exceeded");
  });

  it("distinguishes unset from unknown", () => {
    assert.equal(classify(10, null, 0.8), "unset");
    assert.equal(classify(null, 10, 0.8), "unknown");
  });
});

describe("evaluateLimits", () => {
  it("returns one entry per known limit key", () => {
    const states = evaluateLimits(metrics(), DEFAULT_CONFIG);
    assert.deepEqual(
      states.map((state) => state.key),
      ["time", "cost", "context", "tokens", "turns"],
    );
    assert.ok(states.every((state) => state.status === "unset"));
  });

  it("evaluates each configured limit independently", () => {
    const config = configWith({
      limits: { costUsd: 1, contextPercent: 80, turns: 10 },
      warnRatio: 0.5,
    });
    const states = evaluateLimits(
      metrics({ turns: 9, usage: { ...emptyUsage(), cost: 1.2 }, context: { tokens: 0, contextWindow: 100, percent: 80 } }),
      config,
    );

    const byKey = new Map(states.map((state) => [state.key, state]));
    assert.equal(byKey.get("cost")?.status, "exceeded");
    assert.equal(byKey.get("turns")?.status, "warn");
    assert.equal(byKey.get("context")?.status, "exceeded");
    assert.equal(byKey.get("time")?.status, "unset");
    assert.equal(byKey.get("tokens")?.status, "unset");
  });

  it("reports unknown when a limit is set but the metric is unavailable", () => {
    const config = configWith({ limits: { contextPercent: 80 } });
    const states = evaluateLimits(metrics({ context: null }), config);
    const context = states.find((state) => state.key === "context");
    assert.equal(context?.status, "unknown");
    assert.equal(context?.limit, 80);
  });
});

describe("aggregate helpers", () => {
  const config = configWith({ limits: { costUsd: 1, turns: 5, contextPercent: 90 } });

  it("picks the worst status", () => {
    assert.equal(overallStatus(evaluateLimits(metrics(), DEFAULT_CONFIG)), "unset");
    assert.equal(overallStatus(evaluateLimits(metrics({ turns: 5 }), config)), "exceeded");
    assert.equal(overallStatus(evaluateLimits(metrics({ turns: 4 }), config)), "warn");
    assert.equal(overallStatus(evaluateLimits(metrics({ turns: 1, context: null }), config)), "ok");
  });

  it("lists exceeded and configured keys", () => {
    const states = evaluateLimits(metrics({ turns: 5, context: null }), config);
    assert.deepEqual(exceededKeys(states), ["turns"]);
    assert.deepEqual(configuredKeys(states).sort(), ["context", "cost", "turns"]);
  });

  it("detects whether anything is configured", () => {
    assert.equal(hasAnyLimit(DEFAULT_CONFIG), false);
    assert.equal(hasAnyLimit(config), true);
  });

  it("describes a state in the limit's own units", () => {
    const states = evaluateLimits(metrics({ turns: 5 }), config);
    const turns = states.find((state) => state.key === "turns");
    assert.ok(turns);
    assert.equal(describeState(turns), "turn count: 5 of 5 (100%)");

    const unknown = evaluateLimits(metrics({ context: null }), config).find((state) => state.key === "context");
    assert.ok(unknown);
    assert.match(describeState(unknown), /context usage: 90% budget \(usage unknown\)/);
  });
});
