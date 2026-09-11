import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { addUsage, aggregateEntries, buildMetrics, emptyUsage, resolveStartTime } from "../src/metrics.ts";

function usage(input: number, output: number, total?: number, cost = 0) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: total ?? input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant(options: {
  usage?: ReturnType<typeof usage>;
  stopReason?: string;
  toolCalls?: number;
}): SessionEntry {
  const { usage: record, stopReason = "toolUse", toolCalls = 0 } = options;
  return {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [
        ...Array.from({ length: toolCalls }, (_, index) => ({
          type: "toolCall" as const,
          id: `call-${index}`,
          name: "read",
          arguments: {},
        })),
        { type: "text" as const, text: "done" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "claude",
      usage: record,
      stopReason,
      timestamp: 1,
    },
  } as unknown as SessionEntry;
}

function toolResult(record: ReturnType<typeof usage> | undefined): SessionEntry {
  return {
    type: "message",
    id: "t1",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:01.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call-0",
      toolName: "subagent",
      content: [{ type: "text", text: "ok" }],
      usage: record,
      isError: false,
      timestamp: 2,
    },
  } as unknown as SessionEntry;
}

function customEntry(customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id: "c1",
    parentId: "a1",
    timestamp: "2026-01-01T00:00:02.000Z",
    customType,
    data,
  } as unknown as SessionEntry;
}

describe("addUsage", () => {
  it("ignores missing records", () => {
    const totals = emptyUsage();
    addUsage(totals, undefined);
    addUsage(totals, null);
    assert.deepEqual(totals, emptyUsage());
  });

  it("falls back to summing components when totalTokens is absent", () => {
    const totals = emptyUsage();
    addUsage(totals, { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 });
    assert.equal(totals.total, 18);
  });

  it("prefers a reported total when present", () => {
    const totals = emptyUsage();
    addUsage(totals, { input: 10, output: 5, totalTokens: 100 });
    assert.equal(totals.total, 100);
  });

  it("survives non-numeric fields", () => {
    const totals = emptyUsage();
    addUsage(totals, { input: Number.NaN, output: 4, cost: { total: Number.NaN } });
    assert.equal(totals.input, 0);
    assert.equal(totals.output, 4);
    assert.equal(totals.cost, 0);
  });
});

describe("aggregateEntries", () => {
  it("sums usage and counts turns and tool calls", () => {
    const result = aggregateEntries([
      assistant({ usage: usage(100, 20, 120, 0.01), toolCalls: 2 }),
      toolResult(usage(50, 5, 55, 0.001)),
      assistant({ usage: usage(200, 40, 240, 0.02), stopReason: "stop", toolCalls: 0 }),
    ]);

    assert.equal(result.usage.input, 350);
    assert.equal(result.usage.output, 65);
    assert.equal(result.usage.total, 415);
    assert.ok(Math.abs(result.usage.cost - 0.031) < 1e-9);
    assert.equal(result.turns, 2);
    assert.equal(result.toolCalls, 2);
  });

  it("does not count errored or aborted responses as turns", () => {
    const result = aggregateEntries([
      assistant({ usage: usage(10, 1), stopReason: "error" }),
      assistant({ usage: usage(10, 1), stopReason: "aborted" }),
      assistant({ usage: usage(10, 1), stopReason: "length" }),
    ]);
    assert.equal(result.turns, 1);
  });

  it("counts compaction and branch summary usage", () => {
    const entries = [
      {
        type: "compaction",
        id: "k1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:03.000Z",
        summary: "s",
        firstKeptEntryId: "a1",
        tokensBefore: 10,
        usage: usage(1000, 100, 1100, 0.05),
      },
      {
        type: "branch_summary",
        id: "b1",
        parentId: "a1",
        timestamp: "2026-01-01T00:00:04.000Z",
        fromId: "a1",
        summary: "s",
        usage: usage(500, 50, 550, 0.01),
      },
    ] as unknown as SessionEntry[];

    const result = aggregateEntries(entries);
    assert.equal(result.usage.total, 1650);
    assert.ok(Math.abs(result.usage.cost - 0.06) < 1e-9);
    assert.equal(result.turns, 0);
  });

  it("ignores entries it does not understand", () => {
    const result = aggregateEntries([
      customEntry("governor-state", { paused: true }),
      { type: "model_change", id: "m1", parentId: null, timestamp: "x", provider: "p", modelId: "m" } as unknown as SessionEntry,
    ]);
    assert.deepEqual(result, { usage: emptyUsage(), turns: 0, toolCalls: 0 });
  });

  it("handles an empty session", () => {
    assert.deepEqual(aggregateEntries([]), { usage: emptyUsage(), turns: 0, toolCalls: 0 });
  });
});

describe("buildMetrics", () => {
  it("derives wall time from the baseline", () => {
    const metrics = buildMetrics({
      startedAt: 1_000,
      now: 61_000,
      activeMs: 30_000,
      aggregate: { usage: emptyUsage(), turns: 3, toolCalls: 7 },
      context: { tokens: 10, contextWindow: 200_000, percent: 5 },
    });

    assert.equal(metrics.wallMs, 60_000);
    assert.equal(metrics.activeMs, 30_000);
    assert.equal(metrics.turns, 3);
    assert.equal(metrics.toolCalls, 7);
  });

  it("never reports negative durations", () => {
    const metrics = buildMetrics({
      startedAt: 5_000,
      now: 1_000,
      activeMs: -10,
      aggregate: { usage: emptyUsage(), turns: 0, toolCalls: 0 },
      context: null,
    });
    assert.equal(metrics.wallMs, 0);
    assert.equal(metrics.activeMs, 0);
  });

  it("falls back to now when the baseline is unusable", () => {
    const metrics = buildMetrics({
      startedAt: Number.NaN,
      now: 42,
      activeMs: 0,
      aggregate: { usage: emptyUsage(), turns: 0, toolCalls: 0 },
      context: null,
    });
    assert.equal(metrics.startedAt, 42);
    assert.equal(metrics.wallMs, 0);
  });
});

describe("resolveStartTime", () => {
  it("parses an ISO header timestamp", () => {
    const parsed = resolveStartTime("2026-01-01T00:00:00.000Z", 99);
    assert.equal(parsed, Date.parse("2026-01-01T00:00:00.000Z"));
  });

  it("falls back for missing or invalid timestamps", () => {
    assert.equal(resolveStartTime(undefined, 99), 99);
    assert.equal(resolveStartTime("not-a-date", 99), 99);
  });
});
