import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  applyFlagOverrides,
  DEFAULT_CONFIG,
  mergeConfig,
  parseConfig,
} from "../src/config.ts";

const noFlags = {};

function readRepoJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as unknown;
}

describe("parseConfig", () => {
  it("accepts a fully specified config", () => {
    const diagnostics: string[] = [];
    const patch = parseConfig(
      {
        enabled: true,
        warnRatio: 0.5,
        timeMode: "active",
        exposeTool: true,
        limits: { timeMinutes: 30, costUsd: 2.5, contextPercent: 70, totalTokens: 1000, turns: 12 },
        enforcement: {
          enabled: true,
          onToolCall: "allow",
          onPrompt: "refuse",
          onTurn: "allow",
          onContext: "observe",
        },
        status: { enabled: false, segments: ["cost", "turns"], updateIntervalMs: 2000 },
      },
      "test.json",
      diagnostics,
    );

    assert.deepEqual(diagnostics, []);
    assert.equal(patch.warnRatio, 0.5);
    assert.equal(patch.timeMode, "active");
    assert.equal(patch.exposeTool, true);
    assert.deepEqual(patch.limits, {
      timeMinutes: 30,
      costUsd: 2.5,
      contextPercent: 70,
      totalTokens: 1000,
      turns: 12,
    });
    assert.deepEqual(patch.enforcement, {
      enabled: true,
      onToolCall: "allow",
      onPrompt: "refuse",
      onTurn: "allow",
      onContext: "observe",
    });
    assert.deepEqual(patch.status, { enabled: false, segments: ["cost", "turns"], updateIntervalMs: 2000 });
  });

  it("treats an explicit null limit as cleared", () => {
    const diagnostics: string[] = [];
    const patch = parseConfig({ limits: { costUsd: null } }, "test.json", diagnostics);
    assert.deepEqual(diagnostics, []);
    assert.deepEqual(patch.limits, { costUsd: null });
  });

  it("rejects wrong types and out-of-range numbers without throwing", () => {
    const diagnostics: string[] = [];
    const patch = parseConfig(
      {
        enabled: "yes",
        warnRatio: 5,
        timeMode: "whenever",
        limits: { costUsd: "5", turns: -1, contextPercent: 200 },
        enforcement: { onToolCall: "explode" },
        status: { segments: ["cost", "nonsense"], updateIntervalMs: 10 },
      },
      "test.json",
      diagnostics,
    );

    assert.equal(patch.enabled, undefined);
    assert.equal(patch.warnRatio, undefined);
    assert.equal(patch.timeMode, undefined);
    assert.deepEqual(patch.limits, {});
    assert.deepEqual(patch.enforcement, {});
    assert.deepEqual(patch.status?.segments, ["cost"]);
    assert.equal(patch.status?.updateIntervalMs, undefined);
    // One diagnostic per rejected field: enabled, warnRatio, timeMode,
    // limits.costUsd, limits.contextPercent, limits.turns, onToolCall,
    // status.segments, status.updateIntervalMs.
    assert.equal(diagnostics.length, 9, diagnostics.join("\n"));
  });

  it("rejects a non-object document", () => {
    const diagnostics: string[] = [];
    assert.deepEqual(parseConfig([1, 2, 3], "test.json", diagnostics), {});
    assert.equal(diagnostics.length, 1);
  });

  it("deduplicates status segments", () => {
    const diagnostics: string[] = [];
    const patch = parseConfig({ status: { segments: ["cost", "cost", "turns"] } }, "test.json", diagnostics);
    assert.deepEqual(patch.status?.segments, ["cost", "turns"]);
  });
});

describe("mergeConfig", () => {
  it("deep merges nested sections and keeps untouched defaults", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, { limits: { costUsd: 3 } });
    assert.equal(merged.limits.costUsd, 3);
    assert.equal(merged.limits.turns, DEFAULT_CONFIG.limits.turns);
    assert.equal(merged.enforcement.onToolCall, DEFAULT_CONFIG.enforcement.onToolCall);
    assert.equal(merged.status.updateIntervalMs, DEFAULT_CONFIG.status.updateIntervalMs);
  });

  it("does not mutate the base config", () => {
    mergeConfig(DEFAULT_CONFIG, { limits: { costUsd: 3 } });
    assert.equal(DEFAULT_CONFIG.limits.costUsd, null);
  });
});

describe("applyFlagOverrides", () => {
  it("applies limit flags", () => {
    const diagnostics: string[] = [];
    const config = applyFlagOverrides(
      DEFAULT_CONFIG,
      { maxTime: "45", maxCost: "1.5", maxContext: "60", maxTokens: "500000", maxTurns: "9" },
      diagnostics,
    );

    assert.deepEqual(diagnostics, []);
    assert.equal(config.limits.timeMinutes, 45);
    assert.equal(config.limits.costUsd, 1.5);
    assert.equal(config.limits.contextPercent, 60);
    assert.equal(config.limits.totalTokens, 500_000);
    assert.equal(config.limits.turns, 9);
  });

  it("reports malformed flag values and leaves the limit untouched", () => {
    const diagnostics: string[] = [];
    const config = applyFlagOverrides(DEFAULT_CONFIG, { maxCost: "cheap", maxTurns: "99999999" }, diagnostics);
    assert.equal(config.limits.costUsd, null);
    assert.equal(config.limits.turns, null);
    assert.equal(diagnostics.length, 2);
  });

  it("--governor-off disables everything and --governor-observe only enforcement", () => {
    const off = applyFlagOverrides(DEFAULT_CONFIG, { off: true }, []);
    assert.equal(off.enabled, false);

    const observe = applyFlagOverrides(DEFAULT_CONFIG, { observe: true }, []);
    assert.equal(observe.enabled, true);
    assert.equal(observe.enforcement.enabled, false);
  });

  it("ignores empty strings", () => {
    const diagnostics: string[] = [];
    const config = applyFlagOverrides(DEFAULT_CONFIG, { maxCost: "  " }, diagnostics);
    assert.equal(config.limits.costUsd, null);
    assert.deepEqual(diagnostics, []);
  });

  it("is a no-op with no flags", () => {
    assert.deepEqual(applyFlagOverrides(DEFAULT_CONFIG, noFlags, []), DEFAULT_CONFIG);
  });
});

describe("shipped artifacts", () => {
  it("governor.example.json parses cleanly and matches the documented defaults", () => {
    const diagnostics: string[] = [];
    const patch = parseConfig(readRepoJson("../governor.example.json"), "governor.example.json", diagnostics);

    assert.deepEqual(diagnostics, []);
    const config = mergeConfig(DEFAULT_CONFIG, patch);
    assert.equal(config.enabled, true);
    assert.equal(config.warnRatio, 0.8);
    assert.equal(config.timeMode, "wall");
    assert.equal(config.exposeTool, false);
    assert.equal(config.limits.timeMinutes, 90);
    assert.equal(config.limits.costUsd, 5);
    assert.equal(config.limits.contextPercent, 85);
    assert.equal(config.limits.totalTokens, null);
    assert.equal(config.limits.turns, null);
    assert.deepEqual(config.enforcement, {
      enabled: true,
      onToolCall: "block",
      onPrompt: "refuse",
      onTurn: "abort",
      onContext: "compact",
      onPreflight: "warn",
    });
    assert.deepEqual(config.preflight, {
      enabled: true,
      assumedOutputTokens: 8000,
      useCacheEstimate: true,
    });
    assert.deepEqual(config.status, {
      enabled: true,
      segments: ["cost", "context", "time", "turns"],
      updateIntervalMs: 1000,
    });
  });

  it("governor.schema.json is valid JSON with the documented top-level keys", () => {
    const schema = readRepoJson("../governor.schema.json") as { properties?: Record<string, unknown> };
    assert.ok(schema.properties);
    assert.deepEqual(Object.keys(schema.properties).sort(), [
      "$schema",
      "enabled",
      "enforcement",
      "exposeTool",
      "limits",
      "preflight",
      "status",
      "timeMode",
      "warnRatio",
    ]);
  });
});
