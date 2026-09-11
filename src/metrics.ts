/**
 * Metric collection for pi-governor.
 *
 * All token/cost/turn/tool-call totals are derived from the session entry
 * list rather than from in-memory counters. That makes them stable across
 * `/reload`, resume, fork, and compaction, and it matches the semantics of
 * pi's own session totals: every entry that was billed for is counted.
 *
 * Only a type import is taken from the pi runtime, so this module stays
 * unit-testable without the coding agent installed.
 */

import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
}

export interface ContextInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface EntryAggregate {
  usage: UsageTotals;
  /** Assistant responses that completed normally (excludes errored/aborted). */
  turns: number;
  /** Tool calls requested by the model. */
  toolCalls: number;
}

export interface GovernorMetrics {
  startedAt: number;
  now: number;
  /** Wall-clock milliseconds since the measurement baseline. */
  wallMs: number;
  /** Milliseconds actually spent inside an agent run. */
  activeMs: number;
  turns: number;
  toolCalls: number;
  usage: UsageTotals;
  context: ContextInfo | null;
}

/** Structural view of pi-ai's `Usage`, so this module needs no pi-ai import. */
interface UsageLike {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

/** Stop reasons that represent a wasted response rather than a real turn. */
const NON_TURN_STOP_REASONS = new Set(["error", "aborted", "pending"]);

export function emptyUsage(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Accumulate one usage record into a running total. Missing fields are 0. */
export function addUsage(target: UsageTotals, usage: UsageLike | undefined | null): void {
  if (!usage) return;
  target.input += finite(usage.input);
  target.output += finite(usage.output);
  target.cacheRead += finite(usage.cacheRead);
  target.cacheWrite += finite(usage.cacheWrite);
  target.cost += finite(usage.cost?.total);

  const explicitTotal = finite(usage.totalTokens);
  target.total +=
    explicitTotal > 0
      ? explicitTotal
      : finite(usage.input) + finite(usage.output) + finite(usage.cacheRead) + finite(usage.cacheWrite);
}

/**
 * Aggregate usage, completed turns, and tool calls across every session entry.
 *
 * Includes entries from abandoned branches and compaction summaries, which is
 * intentional: those LLM calls were still billed to the user.
 */
export function aggregateEntries(entries: readonly SessionEntry[]): EntryAggregate {
  const usage = emptyUsage();
  let turns = 0;
  let toolCalls = 0;

  for (const entry of entries) {
    if (!entry) continue;

    if (entry.type === "message") {
      const message = entry.message;

      if (message.role === "assistant") {
        addUsage(usage, message.usage);
        if (!NON_TURN_STOP_REASONS.has(message.stopReason)) turns += 1;
        for (const block of message.content) {
          if (block.type === "toolCall") toolCalls += 1;
        }
      } else if (message.role === "toolResult") {
        // Nested LLM work performed by a tool (e.g. a sub-agent).
        addUsage(usage, message.usage);
      }
      continue;
    }

    // Compaction and branch summaries are LLM calls too.
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      addUsage(usage, entry.usage);
    }
  }

  return { usage, turns, toolCalls };
}

export function buildMetrics(input: {
  startedAt: number;
  now: number;
  activeMs: number;
  aggregate: EntryAggregate;
  context: ContextInfo | null;
}): GovernorMetrics {
  const startedAt = Number.isFinite(input.startedAt) ? input.startedAt : input.now;
  return {
    startedAt,
    now: input.now,
    wallMs: Math.max(0, input.now - startedAt),
    activeMs: Math.max(0, input.activeMs),
    turns: input.aggregate.turns,
    toolCalls: input.aggregate.toolCalls,
    usage: input.aggregate.usage,
    context: input.context,
  };
}

/**
 * Resolve the session start instant from the session header timestamp.
 * Falls back to `fallback` when the header is missing or unparseable.
 */
export function resolveStartTime(headerTimestamp: string | undefined, fallback: number): number {
  if (typeof headerTimestamp === "string") {
    const parsed = Date.parse(headerTimestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}
