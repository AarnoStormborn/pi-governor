/**
 * pi-governor — budget governance for the pi coding agent.
 *
 * The governor measures session time, cost, context usage, tokens, turns, and
 * tool calls against budgets the user configures, then (optionally) enforces
 * those budgets by blocking tool calls, refusing prompts, aborting runs, and
 * compacting context.
 *
 * All measurement is derived from the session entry list, so totals survive
 * `/reload`, resume, fork, and compaction. This file is the wiring layer; the
 * measurement, evaluation, and rendering logic lives in sibling modules and is
 * unit tested without the pi runtime.
 */

import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  DEFAULT_CONFIG,
  loadConfig,
  projectConfigPath,
  writeConfigFile,
  type GovernorConfigPatch,
  type GovernorFlagOverrides,
} from "./config.ts";
import { formatPercent, formatUsd } from "./format.ts";
import {
  describeLimit,
  evaluateLimits,
  exceededKeys,
  projectedOverspendKeys,
  type CostProjection,
  type LimitState,
} from "./limits.ts";
import {
  aggregateEntries,
  buildMetrics,
  emptyUsage,
  resolveStartTime,
  type ContextInfo,
  type EntryAggregate,
  type GovernorMetrics,
} from "./metrics.ts";
import { openGovernorPanel } from "./panel.ts";
import {
  cacheHitRate,
  describeUnpricedModel,
  estimateTurnCost,
  isUnpriced,
  type CostRates,
} from "./projection.ts";
import { renderReportLines, renderStatus } from "./status.ts";
import type { GovernorConfig, LimitKey } from "./types.ts";

const STATUS_KEY = "governor";
const STATE_CUSTOM_TYPE = "governor-state";
const STATUS_TOOL_NAME = "governor_status";

/** Minimum gap between governor-triggered compactions. */
const COMPACTION_COOLDOWN_MS = 15_000;

/** A tool call reuses cached metrics unless they are older than this. */
const METRICS_STALE_AFTER_MS = 250;

interface PersistedGovernorState {
  resetAt?: number | null;
  paused?: boolean;
}

export default function piGovernor(pi: ExtensionAPI): void {
  // ---------------------------------------------------------------------------
  // CLI flags
  // ---------------------------------------------------------------------------
  pi.registerFlag("governor-off", {
    description: "pi-governor: disable the governor entirely for this run",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("governor-observe", {
    description: "pi-governor: measure and report only, never enforce",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("governor-tool", {
    description: "pi-governor: let the model query its own budget via governor_status",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("governor-preflight", {
    description: "pi-governor: forecast next-turn cost — off, warn, or refuse",
    type: "string",
  });
  pi.registerFlag("governor-max-time", {
    description: "pi-governor: session time budget in minutes",
    type: "string",
  });
  pi.registerFlag("governor-max-cost", {
    description: "pi-governor: session cost budget in USD",
    type: "string",
  });
  pi.registerFlag("governor-max-context", {
    description: "pi-governor: context usage ceiling in percent",
    type: "string",
  });
  pi.registerFlag("governor-max-tokens", {
    description: "pi-governor: total token budget",
    type: "string",
  });
  pi.registerFlag("governor-max-turns", {
    description: "pi-governor: maximum number of assistant turns",
    type: "string",
  });

  const asString = (value: boolean | string | undefined): string | undefined =>
    typeof value === "string" ? value : undefined;

  const readFlags = (): GovernorFlagOverrides => ({
    off: pi.getFlag("governor-off") === true,
    observe: pi.getFlag("governor-observe") === true,
    exposeTool: pi.getFlag("governor-tool") === true,
    preflight: asString(pi.getFlag("governor-preflight")),
    maxTime: asString(pi.getFlag("governor-max-time")),
    maxCost: asString(pi.getFlag("governor-max-cost")),
    maxContext: asString(pi.getFlag("governor-max-context")),
    maxTokens: asString(pi.getFlag("governor-max-tokens")),
    maxTurns: asString(pi.getFlag("governor-max-turns")),
  });

  // ---------------------------------------------------------------------------
  // Mutable session state
  // ---------------------------------------------------------------------------
  let config: GovernorConfig = DEFAULT_CONFIG;
  let loadedPaths: string[] = [];
  let missingPaths: string[] = [];
  let configDiagnostics: string[] = [];

  let headerStart = 0;
  let resetAt: number | null = null;
  let paused = false;

  let aggregate: EntryAggregate = { usage: emptyUsage(), turns: 0, toolCalls: 0 };
  let context: ContextInfo | null = null;
  let states: LimitState[] = [];
  let projection: CostProjection | null = null;
  let unpricedWarning: string | null = null;

  let activeMs = 0;
  let activeSince: number | null = null;

  const announced = new Set<string>();
  let lastCompactionAt = 0;
  let lastRefreshAt = 0;
  let previousPercent: number | null = null;
  let lastStatusText = "";
  let timer: ReturnType<typeof setInterval> | null = null;
  let statusToolRegistered = false;

  // ---------------------------------------------------------------------------
  // Derived helpers
  // ---------------------------------------------------------------------------
  const isEnabled = (): boolean => config.enabled;
  const isEnforcing = (): boolean => config.enabled && config.enforcement.enabled && !paused;

  const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error"): void => {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  };

  const metrics = (): GovernorMetrics => {
    const now = Date.now();
    const base = resetAt === null ? headerStart : Math.max(headerStart, resetAt);
    return buildMetrics({
      startedAt: base > 0 ? base : now,
      now,
      activeMs: activeMs + (activeSince === null ? 0 : now - activeSince),
      aggregate,
      context,
    });
  };

  /** Model pricing for the active model, when the registry exposes it. */
  const currentRates = (ctx: ExtensionContext): CostRates | undefined => {
    const cost = ctx.model?.cost;
    if (!cost) return undefined;
    return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
  };

  /**
   * Price the next turn before it is spent. Returns null when pre-flight is
   * disabled, the model is unpriced, or the context size is unknown.
   */
  const projectNextTurn = (ctx: ExtensionContext): CostProjection | null => {
    if (!config.preflight.enabled) return null;

    const estimate = estimateTurnCost(
      {
        contextTokens: context?.tokens ?? null,
        cacheHitRate: cacheHitRate(aggregate.usage),
        assumedOutputTokens: config.preflight.assumedOutputTokens,
        useCacheEstimate: config.preflight.useCacheEstimate,
      },
      currentRates(ctx),
    );
    if (!estimate) return null;

    return {
      turnCost: estimate.total,
      totalCost: aggregate.usage.cost + estimate.total,
      usedCacheEstimate: estimate.usedCacheEstimate,
    };
  };

  /** Re-read every metric and re-evaluate every limit. */
  const refresh = (ctx: ExtensionContext): void => {
    aggregate = aggregateEntries(ctx.sessionManager.getEntries());
    const usage = ctx.getContextUsage();
    context = usage
      ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent }
      : null;
    projection = projectNextTurn(ctx);
    states = evaluateLimits(metrics(), config, projection);
    lastRefreshAt = Date.now();
  };

  /**
   * Re-read metrics only if the cached snapshot is stale. `tool_execution_start`
   * already refreshes immediately before `tool_call`, so this avoids re-scanning
   * every session entry once per tool call in long runs.
   */
  const refreshIfStale = (ctx: ExtensionContext): void => {
    if (Date.now() - lastRefreshAt < METRICS_STALE_AFTER_MS) return;
    refresh(ctx);
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!isEnabled() || !config.status.enabled || !ctx.hasUI) {
      if (lastStatusText !== "") {
        lastStatusText = "";
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
      return;
    }

    const text = renderStatus(states, metrics(), config, ctx.ui.theme, { paused }) ?? "";
    if (text === lastStatusText) return;
    lastStatusText = text;
    ctx.ui.setStatus(STATUS_KEY, text === "" ? undefined : text);
  };

  const announce = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const enforcing = isEnforcing();

    for (const state of states) {
      if (state.status === "warn") {
        const key = `warn:${state.key}`;
        if (announced.has(key)) continue;
        announced.add(key);
        ctx.ui.notify(
          `⚖ ${describeLimit(state.key)} at ${formatPercent((state.ratio ?? 0) * 100)} of budget`,
          "warning",
        );
      } else if (state.status === "exceeded") {
        const key = `exceeded:${state.key}`;
        if (announced.has(key)) continue;
        announced.add(key);
        ctx.ui.notify(
          `⚖ ${describeLimit(state.key)} budget exceeded${enforcing ? " — enforcing" : " — observing only"}`,
          "error",
        );
      }
    }
  };

  const maybeCompact = (ctx: ExtensionContext): void => {
    const current = context?.percent ?? null;
    const limit = config.limits.contextPercent;
    const previous = previousPercent;
    previousPercent = current;

    if (!isEnforcing() || config.enforcement.onContext !== "compact") return;
    if (limit === null || current === null) return;
    if (current < limit) return;
    // Only act on the transition, so the governor does not compact in a loop.
    if (previous !== null && previous >= limit) return;
    if (Date.now() - lastCompactionAt < COMPACTION_COOLDOWN_MS) return;

    lastCompactionAt = Date.now();
    notify(ctx, `⚖ context at ${formatPercent(current)} — compacting to stay under budget`, "warning");
    ctx.compact({
      customInstructions:
        "pi-governor triggered this compaction because the context budget was exceeded. Preserve decisions, file paths, open questions, and unfinished tasks.",
      onError: (error) => notify(ctx, `⚖ governor compaction failed: ${error.message}`, "error"),
    });
  };

  const enforceTurn = (ctx: ExtensionContext): void => {
    if (!isEnforcing() || config.enforcement.onTurn !== "abort") return;
    const exceeded = exceededKeys(states);
    if (exceeded.length === 0) return;
    notify(ctx, `⚖ aborting run — ${exceeded.map(describeLimit).join(", ")} exceeded`, "error");
    ctx.abort();
  };

  /**
   * Refuse a turn that is projected to blow the cost budget before it is paid
   * for. This is the only check that can prevent an overshoot rather than
   * report one, since cost is computed at stream end.
   */
  const enforcePreflight = (ctx: ExtensionContext): boolean => {
    if (!isEnforcing() || !config.preflight.enabled) return false;
    if (config.enforcement.onPreflight !== "refuse") return false;
    if (projection === null || config.limits.costUsd === null) return false;

    const over = projectedOverspendKeys(states);
    if (over.length === 0) return false;

    notify(
      ctx,
      `⚖ refusing prompt — next turn is forecast to cost ~$${formatUsd(projection.turnCost)} ` +
        `(projected total $${formatUsd(projection.totalCost)} of $${formatUsd(config.limits.costUsd)}). ` +
        `Run /governor to raise the limit or reset.`,
      "error",
    );
    return true;
  };

  const stopTimer = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  const startTimer = (ctx: ExtensionContext): void => {
    stopTimer();
    if (!isEnabled() || !config.status.enabled || !ctx.hasUI) return;

    const interval = Math.max(250, config.status.updateIntervalMs);
    timer = setInterval(() => updateStatus(ctx), interval);
    // Never hold the process open just to repaint a status line.
    if (typeof timer === "object" && timer !== null && typeof timer.unref === "function") timer.unref();
  };

  const persist = (): void => {
    pi.appendEntry(STATE_CUSTOM_TYPE, { resetAt, paused } satisfies PersistedGovernorState);
  };

  const restore = (ctx: ExtensionContext): PersistedGovernorState => {
    const entries = ctx.sessionManager.getEntries();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry || entry.type !== "custom" || entry.customType !== STATE_CUSTOM_TYPE) continue;
      const data = entry.data as PersistedGovernorState | undefined;
      return {
        resetAt: typeof data?.resetAt === "number" && Number.isFinite(data.resetAt) ? data.resetAt : null,
        paused: data?.paused === true,
      };
    }
    return { resetAt: null, paused: false };
  };

  const reloadConfig = (ctx: ExtensionContext): void => {
    const result = loadConfig({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      configDirName: CONFIG_DIR_NAME,
      projectTrusted: ctx.isProjectTrusted(),
      flags: readFlags(),
    });
    config = result.config;
    loadedPaths = result.loaded;
    missingPaths = result.missing;
    configDiagnostics = result.diagnostics;
    updatePricingWarning(ctx);
  };

  /** Path this session writes interactive changes to. */
  const projectPath = (ctx: ExtensionContext): string => projectConfigPath(ctx.cwd, CONFIG_DIR_NAME);

  /**
   * Detect a cost limit that can never fire because the active model has no
   * pricing data. Pi computes cost as tokens x rates, so an all-zero table
   * makes every reading $0.00 and the limit silently inert.
   */
  const updatePricingWarning = (ctx: ExtensionContext): void => {
    const configured = config.limits.costUsd !== null;
    const rates = currentRates(ctx);
    if (configured && isUnpriced(rates)) {
      const model = ctx.model;
      unpricedWarning = describeUnpricedModel(model?.provider ?? "unknown", model?.id ?? "unknown");
    } else {
      unpricedWarning = null;
    }
  };

  /**
   * Persist a patch to the project config file and apply it immediately.
   * Falls back to an in-session-only change when the write fails.
   */
  const persistPatch = (ctx: ExtensionContext, patch: GovernorConfigPatch): { ok: boolean; error?: string } => {
    const path = projectPath(ctx);

    // When project-local config is not trusted, writing there would have no
    // effect on the next load. Say so rather than pretending it saved.
    if (!ctx.isProjectTrusted()) {
      return {
        ok: false,
        error: `project not trusted — changes apply to this session only (${path} was not written)`,
      };
    }

    const result = writeConfigFile(path, patch);
    if (!result.ok) return { ok: false, error: result.error };

    // Re-read from disk so the in-memory config matches the file exactly.
    reloadConfig(ctx);
    return { ok: true };
  };

  const resetSession = (ctx: ExtensionContext): void => {
    resetAt = Date.now();
    activeMs = 0;
    activeSince = null;
    announced.clear();
    previousPercent = null;
    lastCompactionAt = 0;
    persist();
    refresh(ctx);
    updateStatus(ctx);
  };

  // ---------------------------------------------------------------------------
  // Optional model-facing status tool
  // ---------------------------------------------------------------------------
  const registerStatusTool = (): void => {
    if (statusToolRegistered) return;
    statusToolRegistered = true;

    pi.registerTool({
      name: STATUS_TOOL_NAME,
      label: "Governor Status",
      description:
        "Report the active pi-governor budgets and how much of each is used. Call this before starting large or expensive work to check whether remaining budget justifies it.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        refresh(ctx);
        const snapshot = metrics();
        const payload = {
          enforcing: isEnforcing(),
          paused,
          configFiles: loadedPaths,
          limits: states
            .filter((state) => state.limit !== null)
            .map((state) => ({
              key: state.key,
              status: state.status,
              value: state.value,
              budget: state.limit,
              ratio: state.ratio,
            })),
          totals: {
            turns: snapshot.turns,
            toolCalls: snapshot.toolCalls,
            tokens: snapshot.usage.total,
            costUsd: snapshot.usage.cost,
            wallMs: snapshot.wallMs,
            activeMs: snapshot.activeMs,
            contextPercent: snapshot.context?.percent ?? null,
            contextTokens: snapshot.context?.tokens ?? null,
          },
        };

        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          details: payload,
        };
      },
    });
  };

  // ---------------------------------------------------------------------------
  // `/governor` command
  // ---------------------------------------------------------------------------
  const showPanel = async (ctx: ExtensionContext, lines: string[]): Promise<void> => {
    // Imported lazily so the extension still loads in runtimes where the TUI
    // package is unavailable (print / JSON / RPC modes never reach this path).
    const { Text, matchesKey } = await import("@earendil-works/pi-tui");

    await ctx.ui.custom<void>((_tui, _theme, _keybindings, done) => {
      const body = new Text(lines.join("\n"), 1, 1);
      return {
        render: (width: number) => body.render(width),
        invalidate: () => body.invalidate(),
        handleInput: (data: string) => {
          if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
            done(undefined);
          }
        },
      };
    });
  };

  const showReport = async (ctx: ExtensionCommandContext): Promise<void> => {
    refresh(ctx);
    updateStatus(ctx);
    const lines = renderReportLines(states, metrics(), config, {
      paused,
      loadedPaths,
      missingPaths,
      diagnostics: configDiagnostics,
      projection: describeProjection(),
      pricingWarning: unpricedWarning ?? undefined,
    });

    if (ctx.mode === "tui") {
      await showPanel(ctx, lines);
      return;
    }
    if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), "info");
  };

  /** Human-readable forecast lines for the report. */
  const describeProjection = (): string[] => {
    if (!config.preflight.enabled) return ["disabled"];
    if (unpricedWarning !== null) return ["unavailable — model has no pricing data"];
    if (projection === null) return ["unavailable — context size unknown"];

    const basis = projection.usedCacheEstimate
      ? `using observed ${formatPercent((cacheHitRate(aggregate.usage) ?? 0) * 100)} cache hit rate`
      : "assuming a cold cache (worst case)";
    return [
      `next turn ~$${formatUsd(projection.turnCost)} ${basis}`,
      `projected total $${formatUsd(projection.totalCost)}` +
        (config.limits.costUsd === null ? "" : ` of $${formatUsd(config.limits.costUsd)}`) +
        ` · output assumption ${config.preflight.assumedOutputTokens} tokens`,
    ];
  };

  const openPanel = async (ctx: ExtensionCommandContext): Promise<void> => {
    // The panel is TUI-only; everywhere else `/governor` prints the report.
    if (ctx.mode !== "tui") {
      await showReport(ctx);
      return;
    }

    refresh(ctx);
    const path = projectPath(ctx);
    const trusted = ctx.isProjectTrusted();

    await openGovernorPanel(ctx, {
      config,
      targetPath: trusted ? path : `${path} (untrusted — session only)`,
      onChange: (patch) => {
        const result = persistPatch(ctx, patch);
        // Always apply in memory, even when the write was skipped, so the panel
        // stays responsive and the user sees their change take effect.
        if (!result.ok) config = { ...config, ...(patch as Partial<GovernorConfig>) } as GovernorConfig;
        refresh(ctx);
        updateStatus(ctx);
      },
    });

    // Re-read once more: in-memory optimistic merges are shallow, so a disk
    // reload is what guarantees the shown state matches the file.
    reloadConfig(ctx);
    refresh(ctx);
    updateStatus(ctx);
  };

  /** `/governor max-cost 5` and friends. */
  const applyQuickLimit = (ctx: ExtensionCommandContext, key: LimitKey, raw: string): void => {
    const parsed = parseQuickLimit(key, raw);
    if (parsed === undefined) {
      notify(ctx, `⚖ could not read "${raw}" as a ${describeLimit(key)} limit`, "error");
      return;
    }

    const patch: GovernorConfigPatch = { limits: { [LIMIT_FIELDS[key]]: parsed } };
    const result = persistPatch(ctx, patch);
    if (!result.ok) config = mergeLocal(config, patch);

    refresh(ctx);
    updateStatus(ctx);
    const shown = parsed === null ? "off" : raw.trim();
    const where = result.ok ? `saved to ${projectPath(ctx)}` : `session only — ${result.error}`;
    notify(ctx, `⚖ ${describeLimit(key)} limit: ${shown} (${where})`, result.ok ? "info" : "warning");
  };

  const LIMIT_FIELDS: Record<LimitKey, keyof GovernorConfig["limits"]> = {
    time: "timeMinutes",
    cost: "costUsd",
    context: "contextPercent",
    tokens: "totalTokens",
    turns: "turns",
  };

  const parseQuickLimit = (key: LimitKey, raw: string): number | null | undefined => {
    const text = raw.trim().toLowerCase();
    if (text === "off" || text === "none" || text === "clear") return null;
    if (text === "") return undefined;

    if (key === "time") {
      const hours = /^(\d+(?:\.\d+)?)h$/.exec(text);
      if (hours) return Number(hours[1]) * 60;
      const minutes = /^(\d+(?:\.\d+)?)m?$/.exec(text);
      return minutes ? Number(minutes[1]) : undefined;
    }
    if (key === "context") {
      const match = /^(\d+(?:\.\d+)?)%?$/.exec(text);
      if (!match) return undefined;
      const value = Number(match[1]);
      return value >= 1 && value <= 100 ? value : undefined;
    }
    if (key === "tokens") {
      const suffixed = /^(\d+(?:\.\d+)?)([kmb])$/.exec(text);
      if (suffixed) {
        const scale = suffixed[2] === "k" ? 1e3 : suffixed[2] === "m" ? 1e6 : 1e9;
        return Number(suffixed[1]) * scale;
      }
      const match = /^(\d+)$/.exec(text);
      return match ? Number(match[1]) : undefined;
    }
    const match = /^(\d+(?:\.\d+)?)$/.exec(text);
    if (!match) return undefined;
    const value = Number(match[1]);
    if (value <= 0) return undefined;
    return key === "turns" ? Math.floor(value) : value;
  };

  const mergeLocal = (base: GovernorConfig, patch: GovernorConfigPatch): GovernorConfig => ({
    enabled: patch.enabled ?? base.enabled,
    warnRatio: patch.warnRatio ?? base.warnRatio,
    timeMode: patch.timeMode ?? base.timeMode,
    exposeTool: patch.exposeTool ?? base.exposeTool,
    limits: { ...base.limits, ...(patch.limits ?? {}) },
    enforcement: { ...base.enforcement, ...(patch.enforcement ?? {}) },
    preflight: { ...base.preflight, ...(patch.preflight ?? {}) },
    status: { ...base.status, ...(patch.status ?? {}) },
  });

  const HELP = [
    "/governor                 open the limit panel (TUI) or print a report",
    "/governor report          print the report instead of the panel",
    "/governor max-cost 5      set a limit: cost | time | context | tokens | turns",
    "/governor time 90m         e.g. max-time 2h, max-context 80%, max-tokens 2m",
    "/governor off             clear one limit (/governor off-cost clears cost)",
    "/governor reset           restart the session clock and clear warnings",
    "/governor pause|resume    stop or restart enforcement",
    "/governor reload          re-read governor.json files and flags",
    "/governor help            this message",
  ].join("\n");

  pi.registerCommand("governor", {
    description: "Configure pi-governor limits, or show current usage",
    getArgumentCompletions: (prefix) => {
      const subcommands = [
        "report",
        "max-cost",
        "max-time",
        "max-context",
        "max-tokens",
        "max-turns",
        "cost",
        "time",
        "context",
        "tokens",
        "turns",
        "off-cost",
        "off-time",
        "off-context",
        "off-tokens",
        "off-turns",
        "pause",
        "resume",
        "reset",
        "reload",
        "help",
      ];
      const items = subcommands
        .filter((name) => name.startsWith(prefix))
        .map((name) => ({ value: name, label: name }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const tokens = args
        .trim()
        .split(/\s+/)
        .filter((token) => token.length > 0);
      const subcommand = tokens[0] ?? "";
      const rest = tokens.slice(1).join(" ").trim();

      // `/governor <limit> <value>` and `/governor max-<limit> <value>`
      const limitMatch = /^(?:max-)?(cost|time|context|tokens|turns)$/.exec(subcommand);
      if (limitMatch) {
        const key = limitMatch[1] as LimitKey;
        if (rest === "") {
          notify(ctx, `⚖ usage: /governor ${subcommand} <value>  (or "off" to clear)`, "warning");
          return;
        }
        applyQuickLimit(ctx, key, rest);
        return;
      }

      // `/governor off-<limit>`
      const clearMatch = /^off-(cost|time|context|tokens|turns)$/.exec(subcommand);
      if (clearMatch) {
        applyQuickLimit(ctx, clearMatch[1] as LimitKey, "off");
        return;
      }

      switch (subcommand) {
        case "report": {
          await showReport(ctx);
          return;
        }
        case "reset": {
          resetSession(ctx);
          notify(ctx, "⚖ governor: session clock and warnings reset", "info");
          return;
        }
        case "pause": {
          paused = true;
          persist();
          refresh(ctx);
          updateStatus(ctx);
          notify(ctx, "⚖ governor: enforcement paused (still measuring)", "warning");
          return;
        }
        case "resume": {
          paused = false;
          persist();
          refresh(ctx);
          updateStatus(ctx);
          notify(ctx, "⚖ governor: enforcement resumed", "info");
          return;
        }
        case "reload": {
          reloadConfig(ctx);
          refresh(ctx);
          updateStatus(ctx);
          const summary =
            loadedPaths.length > 0
              ? `loaded ${loadedPaths.join(", ")}`
              : `no config files found (looked in ${missingPaths.join(", ") || "no candidates"})`;
          const problems = configDiagnostics.length > 0 ? `\n⚠ ${configDiagnostics.join("\n⚠ ")}` : "";
          notify(ctx, `⚖ governor: ${summary}${problems}`, configDiagnostics.length > 0 ? "warning" : "info");
          return;
        }
        case "help": {
          notify(ctx, HELP, "info");
          return;
        }
        case "":
        case "status":
        case "panel":
        case "config":
        default: {
          await openPanel(ctx);
          return;
        }
      }
    },
  });

  // ---------------------------------------------------------------------------
  // Lifecycle events
  // ---------------------------------------------------------------------------
  pi.on("session_start", async (_event, ctx) => {
    const restored = restore(ctx);
    resetAt = restored.resetAt ?? null;
    paused = restored.paused ?? false;

    activeMs = 0;
    activeSince = null;
    announced.clear();
    lastCompactionAt = 0;
    lastRefreshAt = 0;
    previousPercent = null;
    lastStatusText = "";

    headerStart = resolveStartTime(ctx.sessionManager.getHeader()?.timestamp, Date.now());

    reloadConfig(ctx);
    refresh(ctx);
    updateStatus(ctx);
    startTimer(ctx);

    if (config.enabled && config.exposeTool) registerStatusTool();

    if (configDiagnostics.length > 0) {
      notify(
        ctx,
        `⚖ governor: configuration problems\n${configDiagnostics.map((line) => `  ! ${line}`).join("\n")}`,
        "warning",
      );
    }

    // A configured cost limit on an unpriced model can never fire. Say so up
    // front instead of showing a reassuring $0.00 forever.
    if (config.enabled && unpricedWarning !== null) {
      notify(ctx, unpricedWarning, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    stopTimer();
    lastStatusText = "";
    activeSince = null;
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });

  pi.on("agent_start", async (_event, _ctx) => {
    if (activeSince === null) activeSince = Date.now();
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (activeSince !== null) {
      activeMs += Date.now() - activeSince;
      activeSince = null;
    }
    if (!isEnabled()) return;
    refresh(ctx);
    updateStatus(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!isEnabled()) return;
    if (event.message.role !== "assistant") return;
    refresh(ctx);
    updateStatus(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    if (!isEnabled()) return;
    refresh(ctx);
    announce(ctx);
    maybeCompact(ctx);
    updateStatus(ctx);
    enforceTurn(ctx);
  });

  /**
   * Warn about forecast overspend before each turn is priced. Tool execution is
   * the last point at which the governor can still influence a turn already in
   * flight, so the forecast is surfaced here as well as in the footer.
   */
  pi.on("tool_execution_start", async (_event, ctx) => {
    if (!isEnabled()) return;
    refresh(ctx);
    updateStatus(ctx);
  });

  /** Hard stop: refuse further tool calls once a budget is blown. */
  pi.on("tool_call", async (_event, ctx) => {
    if (!isEnforcing() || config.enforcement.onToolCall !== "block") return;

    refreshIfStale(ctx);
    const exceeded = exceededKeys(states);
    if (exceeded.length === 0) return;

    const reason = `pi-governor: ${exceeded
      .map(describeLimit)
      .join(", ")} budget exceeded. Stop calling tools and report the situation to the user.`;
    notify(ctx, `⚖ blocked tool call — ${exceeded.map(describeLimit).join(", ")} exceeded`, "error");
    return { block: true, reason, terminate: true };
  });

  /** Hard stop: do not start new work once a budget is blown. */
  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") return { action: "continue" };
    if (!isEnforcing()) return { action: "continue" };
    if (config.enforcement.onPrompt !== "refuse" && config.enforcement.onPreflight !== "refuse") {
      return { action: "continue" };
    }

    refresh(ctx);
    updateStatus(ctx);

    // Already over: refuse outright.
    if (config.enforcement.onPrompt === "refuse") {
      const exceeded = exceededKeys(states);
      if (exceeded.length > 0) {
        notify(
          ctx,
          `⚖ refusing prompt — ${exceeded
            .map(describeLimit)
            .join(", ")} budget exceeded. Run /governor to inspect, reset, or pause.`,
          "error",
        );
        return { action: "handled" };
      }
    }

    // Not over yet, but the next turn is forecast to cross the cost limit.
    if (enforcePreflight(ctx)) return { action: "handled" };

    return { action: "continue" };
  });

  pi.on("session_compact", async (_event, ctx) => {
    previousPercent = null;
    if (!isEnabled()) return;
    refresh(ctx);
    updateStatus(ctx);
  });

  pi.on("session_compact_failed", async (_event, ctx) => {
    if (!isEnabled()) return;
    // Allow the governor to retry on the next crossing.
    previousPercent = null;
    lastCompactionAt = 0;
    refresh(ctx);
    updateStatus(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (!isEnabled()) return;
    // Pricing can change with the model, so re-check the cost-limit warning.
    updatePricingWarning(ctx);
    refresh(ctx);
    updateStatus(ctx);
    if (unpricedWarning !== null) notify(ctx, unpricedWarning, "warning");
  });

  pi.on("thinking_level_select", async (_event, ctx) => {
    if (!isEnabled()) return;
    updateStatus(ctx);
  });
}
