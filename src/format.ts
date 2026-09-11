/**
 * Small, dependency-free value formatters.
 *
 * These are kept pure so they can be unit tested without the pi runtime and
 * reused by both the footer status line and the `/governor` report.
 */

import type { LimitKey } from "./types.ts";

/** Placeholder for a value that is not available. */
export const EMPTY = "—";

/** Format a USD amount with precision proportional to its magnitude. */
export function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY;
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(2);
  if (abs === 0) return "0.00";
  if (abs >= 0.01) return value.toFixed(3);
  return value.toFixed(4);
}

/** Format a duration in milliseconds as `12m`, `1h05m`, or `45s`. */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return EMPTY;
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

/** Format a token count as `950`, `1.2k`, `45k`, or `1.5M`. */
export function formatTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY;
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  if (abs < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (abs < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (abs < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs < 1_000_000_000) return `${Math.round(value / 1_000_000)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

/** Format a 0-100 percentage value. */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY;
  return `${Math.round(value)}%`;
}

/** Format a 0-1 ratio as a percentage. */
export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return EMPTY;
  return `${Math.round(ratio * 100)}%`;
}

/** Format a raw metric value using the units appropriate to its limit. */
export function formatLimitValue(key: LimitKey, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return EMPTY;
  switch (key) {
    case "time":
      return formatDuration(value);
    case "cost":
      return `$${formatUsd(value)}`;
    case "context":
      return formatPercent(value);
    case "tokens":
      return formatTokens(value);
    case "turns":
      return String(Math.round(value));
    default:
      return String(Math.round(value));
  }
}
