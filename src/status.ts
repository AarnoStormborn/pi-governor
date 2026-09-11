/**
 * Rendering for pi-governor.
 *
 * Two surfaces are produced here:
 *   - the one-line footer status (`renderStatus`)
 *   - the multi-line `/governor` report (`renderReportLines`)
 *
 * Both are pure functions of the evaluated limit states, so they can be
 * snapshot tested with a stub theme.
 */

import { EMPTY, formatDuration, formatLimitValue, formatPercent, formatTokens, formatUsd } from "./format.ts";
import { describeLimit, overallStatus, type LimitState, type LimitStatus } from "./limits.ts";
import { hasAnyLimit } from "./limits.ts";
import type { GovernorMetrics } from "./metrics.ts";
import { STATUS_SEGMENTS, type GovernorConfig, type LimitKey, type StatusSegment } from "./types.ts";

/** Report ordering: cost first, since that is what most users govern. */
const REPORT_ORDER = STATUS_SEGMENTS.filter((segment): segment is LimitKey => segment !== "toolCalls");

/** Colors used by the governor, all present in every built-in theme. */
export type StatusColor = "dim" | "warning" | "error" | "accent" | "muted";

/**
 * Structural subset of pi's `Theme`. Declaring it locally keeps the rendering
 * layer testable without importing the pi runtime.
 */
export interface StatusTheme {
  fg(color: StatusColor, text: string): string;
}

export interface StatusOptions {
  paused?: boolean;
}

export function statusColor(status: LimitStatus): StatusColor {
  switch (status) {
    case "exceeded":
      return "error";
    case "warn":
      return "warning";
    case "ok":
      return "accent";
    default:
      return "dim";
  }
}

function segmentFor(key: StatusSegment, states: readonly LimitState[], metrics: GovernorMetrics): string {
  if (key === "toolCalls") {
    return `${metrics.toolCalls} calls`;
  }

  const state = states.find((candidate) => candidate.key === key);
  if (!state) return "";

  const value = formatLimitValue(state.key, state.value);
  const limit = state.limit === null ? null : formatLimitValue(state.key, state.limit);
  // Only surface the projection once it actually crosses the limit, so the
  // common case stays readable.
  const projection = projectionSuffix(state);

  switch (key) {
    case "context": {
      const shown = state.value === null ? "?" : formatPercent(state.value);
      return limit === null ? `ctx ${shown}` : `ctx ${shown}/${limit}`;
    }
    case "tokens": {
      const shown = formatTokens(state.value);
      return limit === null ? `tok ${shown}` : `tok ${shown}/${limit}`;
    }
    case "turns": {
      const shown = state.value === null ? "?" : String(Math.round(state.value));
      return limit === null ? `${shown}t` : `${shown}/${limit}t`;
    }
    case "cost": {
      const shown = state.value === null ? EMPTY : `$${formatUsd(state.value)}`;
      return limit === null ? `${shown}${projection}` : `${shown}${projection}/$${formatUsd(state.limit)}`;
    }
    case "time": {
      const shown = formatDuration(state.value);
      return limit === null ? shown : `${shown}/${limit}`;
    }
    default:
      return `${key} ${value}`;
  }
}

/** `→$6.40` when the projected next turn would cross the cost limit. */
function projectionSuffix(state: LimitState): string {
  if (state.key !== "cost") return "";
  if (state.projectedStatus !== "exceeded" || state.projectedValue === null) return "";
  if (state.projectedValue === state.value) return "";
  return `→$${formatUsd(state.projectedValue)}`;
}

/**
 * Render the compact footer status line, or `undefined` when the status line
 * is disabled by configuration.
 */
export function renderStatus(
  states: readonly LimitState[],
  metrics: GovernorMetrics,
  config: GovernorConfig,
  theme: StatusTheme,
  options: StatusOptions = {},
): string | undefined {
  if (!config.status.enabled) return undefined;

  if (!hasAnyLimit(config)) {
    return theme.fg("dim", "⚖ unconfigured");
  }

  const parts = config.status.segments
    .map((segment) => segmentFor(segment, states, metrics))
    .filter((part) => part.length > 0);

  const overall = overallStatus(states);
  // A projected overspend is actionable even before it lands.
  const escalating = states.some(
    (state) => state.key === "cost" && state.projectedStatus === "exceeded",
  );
  const worst: LimitStatus = escalating && overall !== "exceeded" ? "exceeded" : overall;
  const suffix = options.paused ? theme.fg("muted", " ⏸") : "";
  return theme.fg(statusColor(worst), `⚖ ${parts.join(" · ")}`) + suffix;
}

export interface ReportInfo {
  paused: boolean;
  loadedPaths: string[];
  missingPaths: string[];
  diagnostics: string[];
  /** Lines describing cost projection, when available. */
  projection?: string[];
  /** Warning about an unpriced model, when applicable. */
  pricingWarning?: string;
}

function pad(label: string, width: number): string {
  return label.length >= width ? label : label + " ".repeat(width - label.length);
}

function limitLine(state: LimitState, labelWidth: number): string {
  const label = pad(describeLimit(state.key), labelWidth);

  if (state.status === "unset") {
    return `${label}  not configured`;
  }
  if (state.status === "unknown") {
    return `${label}  ${formatLimitValue(state.key, state.limit)} budget · usage unknown`;
  }

  const value = formatLimitValue(state.key, state.value);
  const limit = formatLimitValue(state.key, state.limit);
  const percent = formatPercent((state.ratio ?? 0) * 100);
  return `${label}  ${pad(value, 8)} / ${pad(limit, 8)} ${pad(percent, 5)} [${state.status}]`;
}

/** Build the plain-text body of the `/governor` report. */
export function renderReportLines(
  states: readonly LimitState[],
  metrics: GovernorMetrics,
  config: GovernorConfig,
  info: ReportInfo,
): string[] {
  const lines: string[] = [];
  const enforced = config.enabled && config.enforcement.enabled && !info.paused;
  const mode = enforced ? "enforcing" : info.paused ? "paused" : "observing only";

  lines.push(`pi-governor · ${mode} · warn at ${formatPercent(config.warnRatio * 100)}${config.enabled ? "" : " · disabled"}`);
  lines.push("");

  const labelWidth = 14;
  for (const key of REPORT_ORDER) {
    const state = states.find((candidate) => candidate.key === key);
    if (state) lines.push(limitLine(state, labelWidth));
  }
  lines.push(`${pad("tool calls", labelWidth)}  ${metrics.toolCalls}`);
  lines.push("");

  const window = metrics.context?.contextWindow;
  const contextLine =
    window === undefined
      ? `${pad("context window", labelWidth)}  ${EMPTY}`
      : `${pad("context window", labelWidth)}  ${formatTokens(window)} tokens · ${formatPercent(
          metrics.context?.percent ?? null,
        )} used`;
  lines.push(contextLine);

  const started = new Date(metrics.startedAt).toISOString().slice(11, 16);
  lines.push(
    `${pad("elapsed", labelWidth)}  ${formatDuration(metrics.wallMs)} wall · ${formatDuration(
      metrics.activeMs,
    )} active · since ${started} UTC`,
  );
  lines.push(`${pad("time limit on", labelWidth)}  ${config.timeMode === "active" ? "active time" : "wall clock"}`);

  if (info.projection && info.projection.length > 0) {
    lines.push("");
    for (const line of info.projection) {
      lines.push(`${pad("forecast", labelWidth)}  ${line}`);
    }
  }

  if (info.pricingWarning) {
    lines.push("");
    lines.push(`  ! ${info.pricingWarning}`);
  }

  if (info.loadedPaths.length > 0) {
    for (const path of info.loadedPaths) {
      lines.push(`${pad("config", labelWidth)}  ${path}`);
    }
  } else {
    lines.push(`${pad("config", labelWidth)}  none found (${info.missingPaths.join(", ") || "no candidates"})`);
  }

  if (info.diagnostics.length > 0) {
    lines.push("");
    lines.push("problems:");
    for (const diagnostic of info.diagnostics) {
      lines.push(`  ! ${diagnostic}`);
    }
  }

  return lines;
}

/** Notification text summarising an exceeded budget. */
export function exceededSummary(states: readonly LimitState[], enforcing: boolean): string {
  const names = states.filter((state) => state.status === "exceeded").map((state) => describeLimit(state.key));
  const suffix = enforcing ? " — enforcing" : " — observing only";
  return `${names.join(", ")} budget exceeded${suffix}`;
}

/** Placeholder used by the status line for an unknown value. */
export const UNKNOWN_MARKER = "?";
