/**
 * Configuration vocabulary for pi-governor.
 *
 * Every knob the governor understands is described here. `config.ts` is
 * responsible for turning untrusted JSON + CLI flags into these shapes.
 */

/** A budget the governor can measure, warn about, and enforce. */
export type LimitKey = "time" | "cost" | "context" | "tokens" | "turns";

/** Anything the governor can render in the footer status line. */
export type StatusSegment = LimitKey | "toolCalls";

/** Canonical ordering used by evaluation, reporting, and the `/governor` panel. */
export const LIMIT_KEYS = [
  "time",
  "cost",
  "context",
  "tokens",
  "turns",
] as const satisfies readonly LimitKey[];

/** Canonical ordering of every renderable status segment. */
export const STATUS_SEGMENTS = [
  "cost",
  "context",
  "time",
  "tokens",
  "turns",
  "toolCalls",
] as const satisfies readonly StatusSegment[];

/** Human labels used in notifications and reports. */
export const LIMIT_LABELS: Record<LimitKey, string> = {
  time: "session time",
  cost: "session cost",
  context: "context usage",
  tokens: "token usage",
  turns: "turn count",
};

export interface GovernorLimits {
  /** Wall-clock (or active) session budget, in minutes. */
  timeMinutes: number | null;
  /** Session cost budget, in USD. */
  costUsd: number | null;
  /** Context-window ceiling as a percentage of the window (0-100]. */
  contextPercent: number | null;
  /** Total token budget (input + output + cache read + cache write). */
  totalTokens: number | null;
  /** Maximum number of completed assistant turns. */
  turns: number | null;
}

export interface GovernorEnforcement {
  /** Master switch for acting on exceeded limits. */
  enabled: boolean;
  /** Block tool calls once a limit is exceeded. */
  onToolCall: "block" | "allow";
  /** Refuse new user prompts once a limit is exceeded. */
  onPrompt: "refuse" | "allow";
  /** Abort the running agent once a limit is exceeded. */
  onTurn: "abort" | "allow";
  /** Compact the context once the context limit is exceeded. */
  onContext: "compact" | "observe";
  /**
   * React when the *next* turn is projected to cross a cost limit.
   * `"warn"` reports only; `"refuse"` stops the turn before it is paid for.
   */
  onPreflight: "warn" | "refuse";
}

export interface GovernorPreflight {
  /** Price the next turn before spending it. */
  enabled: boolean;
  /** Output tokens to assume when pricing the next turn. */
  assumedOutputTokens: number;
  /**
   * Credit the observed cache hit rate instead of assuming a cold cache.
   * Off is the conservative worst case (whole context at full input rate).
   */
  useCacheEstimate: boolean;
}

export interface GovernorStatusConfig {
  enabled: boolean;
  /** Which metrics to render, in order. */
  segments: StatusSegment[];
  /** Minimum milliseconds between footer refreshes. */
  updateIntervalMs: number;
}

export interface GovernorConfig {
  /** Master switch. When false the extension is completely inert. */
  enabled: boolean;
  /** Fraction of a limit at which the governor starts warning, in (0, 1). */
  warnRatio: number;
  /** Whether the `time` limit measures wall-clock or agent-active time. */
  timeMode: "wall" | "active";
  limits: GovernorLimits;
  enforcement: GovernorEnforcement;
  preflight: GovernorPreflight;
  status: GovernorStatusConfig;
  /** Register a `governor_status` tool the model can call to self-throttle. */
  exposeTool: boolean;
}
