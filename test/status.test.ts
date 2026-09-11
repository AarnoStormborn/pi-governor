import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config.ts";
import { evaluateLimits } from "../src/limits.ts";
import { emptyUsage, type GovernorMetrics } from "../src/metrics.ts";
import { renderReportLines, renderStatus, statusColor, type StatusTheme } from "../src/status.ts";
import type { GovernorConfig } from "../src/types.ts";

const theme: StatusTheme = {
  fg: (color, text) => `[${color}]${text}`,
};

function metrics(overrides: Partial<GovernorMetrics> = {}): GovernorMetrics {
  return {
    startedAt: Date.UTC(2026, 0, 1, 9, 10, 0),
    now: Date.UTC(2026, 0, 1, 9, 22, 0),
    wallMs: 12 * 60_000,
    activeMs: 5 * 60_000,
    turns: 8,
    toolCalls: 42,
    usage: { ...emptyUsage(), input: 900_000, output: 300_000, total: 1_200_000, cost: 1.24 },
    context: { tokens: 68_000, contextWindow: 200_000, percent: 34 },
    ...overrides,
  };
}

function configWith(patch: Parameters<typeof mergeConfig>[1]): GovernorConfig {
  return mergeConfig(DEFAULT_CONFIG, patch);
}

const budgeted = configWith({
  limits: { timeMinutes: 90, costUsd: 5, contextPercent: 85, turns: 50 },
  status: { segments: ["cost", "context", "time", "turns"] },
});

const render = (config: GovernorConfig, sample = metrics(), options = {}) =>
  renderStatus(evaluateLimits(sample, config), sample, config, theme, options);

describe("statusColor", () => {
  it("maps severity onto theme colors", () => {
    assert.equal(statusColor("exceeded"), "error");
    assert.equal(statusColor("warn"), "warning");
    assert.equal(statusColor("ok"), "accent");
    assert.equal(statusColor("unset"), "dim");
    assert.equal(statusColor("unknown"), "dim");
  });
});

describe("renderStatus", () => {
  it("returns undefined when the status line is disabled", () => {
    assert.equal(render(configWith({ status: { enabled: false } })), undefined);
  });

  it("says so when nothing is configured", () => {
    assert.equal(render(DEFAULT_CONFIG), "[dim]⚖ unconfigured");
  });

  it("renders each configured segment in the configured order", () => {
    assert.equal(render(budgeted), "[accent]⚖ $1.24/$5.00 · ctx 34%/85% · 12m/1h30m · 8/50t");
  });

  it("honours the configured segment order and subset", () => {
    const config = configWith({
      limits: { costUsd: 5, turns: 50 },
      status: { segments: ["turns", "cost"] },
    });
    assert.equal(render(config), "[accent]⚖ 8/50t · $1.24/$5.00");
  });

  it("drops the limit half for unconfigured segments", () => {
    const config = configWith({ limits: { costUsd: 5 }, status: { segments: ["cost", "context", "tokens", "time"] } });
    assert.equal(render(config), "[accent]⚖ $1.24/$5.00 · ctx 34% · tok 1.2M · 12m");
  });

  it("uses a question mark when the value is unknown but the limit is set", () => {
    const config = configWith({ limits: { contextPercent: 80 }, status: { segments: ["context"] } });
    const sample = metrics({ context: null });
    assert.equal(render(config, sample), "[dim]⚖ ctx ?/80%");
  });

  it("escalates color as budgets are consumed", () => {
    const warn = render(budgeted, metrics({ turns: 45 }));
    assert.ok(warn?.startsWith("[warning]"), warn);

    const exceeded = render(budgeted, metrics({ usage: { ...emptyUsage(), cost: 6 } }));
    assert.ok(exceeded?.startsWith("[error]"), exceeded);
  });

  it("can render tool call counts without a limit", () => {
    const config = configWith({ limits: { costUsd: 5 }, status: { segments: ["toolCalls", "cost"] } });
    assert.equal(render(config), "[accent]⚖ 42 calls · $1.24/$5.00");
  });

  it("marks a paused governor", () => {
    assert.equal(
      render(budgeted, metrics(), { paused: true }),
      "[accent]⚖ $1.24/$5.00 · ctx 34%/85% · 12m/1h30m · 8/50t[muted] ⏸",
    );
  });
});

describe("renderReportLines", () => {
  const info = {
    paused: false,
    loadedPaths: ["/home/me/.pi/agent/governor.json"],
    missingPaths: [],
    diagnostics: [],
  };

  it("summarises mode and budgets", () => {
    const lines = renderReportLines(evaluateLimits(metrics(), budgeted), metrics(), budgeted, info);
    const text = lines.join("\n");

    assert.match(text, /pi-governor · enforcing · warn at 80%/);
    assert.match(text, /session cost\s+\$1\.24\s+\/ \$5\.00\s+25%/);
    assert.match(text, /context usage\s+34%\s+\/ 85%\s+40%/);
    assert.match(text, /turn count\s+8\s+\/ 50\s+16%/);
    assert.match(text, /tool calls\s+42/);
    assert.match(text, /context window\s+200k tokens · 34% used/);
    assert.match(text, /time limit on\s+wall clock/);
    assert.match(text, /\/home\/me\/\.pi\/agent\/governor\.json/);
  });

  it("reports observing mode when enforcement is off", () => {
    const config = configWith({ enforcement: { enabled: false } });
    const lines = renderReportLines(evaluateLimits(metrics(), config), metrics(), config, info);
    assert.match(lines[0] ?? "", /observing only/);
  });

  it("reports paused mode", () => {
    const lines = renderReportLines(evaluateLimits(metrics(), budgeted), metrics(), budgeted, {
      ...info,
      paused: true,
    });
    assert.match(lines[0] ?? "", /paused/);
  });

  it("lists configuration problems", () => {
    const lines = renderReportLines(evaluateLimits(metrics(), budgeted), metrics(), budgeted, {
      ...info,
      diagnostics: ["bad.json: invalid JSON (unexpected token)"],
    });
    assert.match(lines.join("\n"), /problems:/);
    assert.match(lines.join("\n"), /! bad\.json: invalid JSON/);
  });

  it("notes when no config file was found", () => {
    const lines = renderReportLines(evaluateLimits(metrics(), budgeted), metrics(), budgeted, {
      ...info,
      loadedPaths: [],
      missingPaths: ["/home/me/.pi/agent/governor.json"],
    });
    assert.match(lines.join("\n"), /none found \(\/home\/me\/\.pi\/agent\/governor\.json\)/);
  });

  it("marks unconfigured limits", () => {
    const lines = renderReportLines(evaluateLimits(metrics(), DEFAULT_CONFIG), metrics(), DEFAULT_CONFIG, info);
    assert.match(lines.join("\n"), /session cost\s+not configured/);
  });
});
