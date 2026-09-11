/**
 * The interactive governor panel.
 *
 * A `SettingsList` where every limit and enforcement switch can be changed
 * live. Numeric limits open a submenu with a free-text `Input` so any value is
 * reachable, while enforcement toggles cycle through their allowed values.
 *
 * This module only produces config patches; the caller decides where they are
 * persisted and when to re-evaluate.
 */

import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Input,
  type SettingItem,
  SettingsList,
  Text,
  type Component,
} from "@earendil-works/pi-tui";
import type { GovernorConfigPatch } from "./config.ts";
import { formatDuration, formatPercent, formatTokens, formatUsd } from "./format.ts";
import type { GovernorConfig, LimitKey, StatusSegment } from "./types.ts";

export interface PanelOptions {
  config: GovernorConfig;
  /** Absolute path the panel writes to, shown in the footer. */
  targetPath: string;
  /** Apply a patch. Called on every change so limits take effect immediately. */
  onChange(patch: GovernorConfigPatch): void;
}

/** Keys the panel exposes as numeric limits, with their units and bounds. */
interface NumericSpec {
  id: string;
  label: string;
  description: string;
  field: keyof GovernorConfig["limits"];
  min: number;
  max: number;
  /** Read the current value from config. */
  read(config: GovernorConfig): number | null;
  /** Render a stored value for display. */
  format(value: number | null): string;
  /** Render a value while editing, with its unit. */
  formatEditing(value: number | null): string;
  /** Parse free text into the stored value, or null for "off". */
  parse(raw: string): number | null | undefined;
}

const NUMERIC_SPECS: readonly NumericSpec[] = [
  {
    id: "limit.cost",
    label: "Cost limit",
    description: "Refuse or block once session cost reaches this amount (USD)",
    field: "costUsd",
    min: 0.0001,
    max: 10_000_000,
    read: (config) => config.limits.costUsd,
    format: (value) => (value === null ? "off" : `$${formatUsd(value)}`),
    formatEditing: (value) => (value === null ? "off" : String(value)),
    parse: (raw) => {
      const text = raw.trim().replace(/^\$/, "");
      if (text === "" || text.toLowerCase() === "off" || text.toLowerCase() === "none") return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    },
  },
  {
    id: "limit.time",
    label: "Time limit",
    description: "Session time budget in minutes",
    field: "timeMinutes",
    min: 0.1,
    max: 100_000,
    read: (config) => config.limits.timeMinutes,
    format: (value) => (value === null ? "off" : `${value}m (${formatDuration(value * 60_000)})`),
    formatEditing: (value) => (value === null ? "off" : String(value)),
    parse: (raw) => {
      const text = raw.trim().toLowerCase();
      if (text === "" || text === "off" || text === "none") return null;
      // Accept "90", "90m", "1h30m", "2h".
      const hours = /^(\d+(?:\.\d+)?)\s*h/.exec(text);
      const minutes = /(\d+(?:\.\d+)?)\s*m/.exec(text);
      if (hours || minutes) {
        const total = (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
        return Number.isFinite(total) && total > 0 ? total : undefined;
      }
      const parsed = Number(text);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    },
  },
  {
    id: "limit.context",
    label: "Context limit",
    description: "Context window usage ceiling as a percentage",
    field: "contextPercent",
    min: 1,
    max: 100,
    read: (config) => config.limits.contextPercent,
    format: (value) => (value === null ? "off" : formatPercent(value)),
    formatEditing: (value) => (value === null ? "off" : String(value)),
    parse: (raw) => {
      const text = raw.trim().replace(/%$/, "");
      if (text === "" || text.toLowerCase() === "off" || text.toLowerCase() === "none") return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) && parsed >= 1 && parsed <= 100 ? parsed : undefined;
    },
  },
  {
    id: "limit.tokens",
    label: "Token limit",
    description: "Total token budget for the session",
    field: "totalTokens",
    min: 1,
    max: 1_000_000_000_000,
    read: (config) => config.limits.totalTokens,
    format: (value) => (value === null ? "off" : formatTokens(value)),
    formatEditing: (value) => (value === null ? "off" : String(value)),
    parse: (raw) => {
      const text = raw.trim().toLowerCase().replace(/[_,]/g, "");
      if (text === "" || text === "off" || text === "none") return null;
      const suffixed = /^(\d+(?:\.\d+)?)\s*([kmb])$/.exec(text);
      if (suffixed) {
        const scale = suffixed[2] === "k" ? 1e3 : suffixed[2] === "m" ? 1e6 : 1e9;
        return Number(suffixed[1]) * scale;
      }
      const parsed = Number(text);
      return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
    },
  },
  {
    id: "limit.turns",
    label: "Turn limit",
    description: "Maximum number of completed assistant turns",
    field: "turns",
    min: 1,
    max: 10_000_000,
    read: (config) => config.limits.turns,
    format: (value) => (value === null ? "off" : String(value)),
    formatEditing: (value) => (value === null ? "off" : String(value)),
    parse: (raw) => {
      const text = raw.trim().toLowerCase();
      if (text === "" || text === "off" || text === "none") return null;
      const parsed = Number(text);
      return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : undefined;
    },
  },
];

const ENFORCEMENT_SPECS: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  field: keyof GovernorConfig["enforcement"];
  values: readonly string[];
}> = [
  {
    id: "enforce.enabled",
    label: "Enforcement",
    description: "Act on exceeded limits; off means measure and report only",
    field: "enabled",
    values: ["on", "off"],
  },
  {
    id: "enforce.onToolCall",
    label: "When over budget: tools",
    description: "Block tool calls once a limit is exceeded",
    field: "onToolCall",
    values: ["block", "allow"],
  },
  {
    id: "enforce.onPrompt",
    label: "When over budget: prompts",
    description: "Refuse new prompts once a limit is exceeded",
    field: "onPrompt",
    values: ["refuse", "allow"],
  },
  {
    id: "enforce.onTurn",
    label: "When over budget: turns",
    description: "Abort the running agent at the end of a turn",
    field: "onTurn",
    values: ["abort", "allow"],
  },
  {
    id: "enforce.onContext",
    label: "When over budget: context",
    description: "Compact the context when the context limit is crossed",
    field: "onContext",
    values: ["compact", "observe"],
  },
  {
    id: "enforce.onPreflight",
    label: "Forecast overspend",
    description: "React before a turn that is projected to cross the cost limit is spent",
    field: "onPreflight",
    values: ["warn", "refuse"],
  },
];

const SEGMENT_LABELS: ReadonlyArray<{ segment: StatusSegment; label: string }> = [
  { segment: "cost", label: "cost" },
  { segment: "context", label: "context" },
  { segment: "time", label: "time" },
  { segment: "tokens", label: "tokens" },
  { segment: "turns", label: "turns" },
  { segment: "toolCalls", label: "tool calls" },
];

const TIME_MODES = ["wall", "active"] as const;

function booleanToOnOff(value: boolean): string {
  return value ? "on" : "off";
}

/** Read the display value for any panel row. */
function displayValue(id: string, config: GovernorConfig): string {
  const numeric = NUMERIC_SPECS.find((spec) => spec.id === id);
  if (numeric) return numeric.format(numeric.read(config));

  switch (id) {
    case "enforce.enabled":
      return booleanToOnOff(config.enforcement.enabled);
    case "enforce.onToolCall":
      return config.enforcement.onToolCall;
    case "enforce.onPrompt":
      return config.enforcement.onPrompt;
    case "enforce.onTurn":
      return config.enforcement.onTurn;
    case "enforce.onContext":
      return config.enforcement.onContext;
    case "enforce.onPreflight":
      return config.enforcement.onPreflight;
    case "preflight.enabled":
      return booleanToOnOff(config.preflight.enabled);
    case "preflight.assumedOutputTokens":
      return formatTokens(config.preflight.assumedOutputTokens);
    case "preflight.useCacheEstimate":
      return booleanToOnOff(config.preflight.useCacheEstimate);
    case "status.enabled":
      return booleanToOnOff(config.status.enabled);
    case "status.segments":
      return config.status.segments.length === 0 ? "none" : config.status.segments.join(",");
    case "misc.timeMode":
      return config.timeMode;
    case "misc.warnRatio":
      return formatPercent(config.warnRatio * 100);
    default:
      return "";
  }
}

/** Turn a raw `onChange` string back into a config patch. */
function patchFor(id: string, value: string, config: GovernorConfig): GovernorConfigPatch | null {
  const numeric = NUMERIC_SPECS.find((spec) => spec.id === id);
  if (numeric) {
    const parsed = numeric.parse(value);
    if (parsed === undefined) return null;
    return { limits: { [numeric.field]: parsed } };
  }

  const enforcement = ENFORCEMENT_SPECS.find((spec) => spec.id === id);
  if (enforcement) {
    if (enforcement.field === "enabled") {
      return { enforcement: { enabled: value === "on" } };
    }
    return { enforcement: { [enforcement.field]: value } } as GovernorConfigPatch;
  }

  switch (id) {
    case "preflight.enabled":
      return { preflight: { enabled: value === "on" } };
    case "preflight.assumedOutputTokens": {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 1 ? { preflight: { assumedOutputTokens: parsed } } : null;
    }
    case "preflight.useCacheEstimate":
      return { preflight: { useCacheEstimate: value === "on" } };
    case "status.enabled":
      return { status: { enabled: value === "on" } };
    case "misc.timeMode":
      return value === "wall" || value === "active" ? { timeMode: value } : null;
    case "misc.warnRatio": {
      const parsed = Number(value.replace(/%$/, ""));
      return Number.isFinite(parsed) && parsed >= 5 && parsed <= 100 ? { warnRatio: parsed / 100 } : null;
    }
    default:
      return null;
  }
}

/** A submenu wrapping a single-line text input for free-form numeric entry. */
function numericSubmenu(
  spec: NumericSpec,
  config: GovernorConfig,
  done: (value?: string) => void,
): Component {
  const current = spec.read(config);
  const input = new Input({
    prompt: `${spec.label} (${spec.min}–${spec.max}, or "off"): `,
    placeholder: spec.formatEditing(current),
  });
  input.setValue(current === null ? "" : String(current));

  const container = new Container();
  container.addChild(new Text(spec.description, 1, 1));
  container.addChild(input);

  input.onSubmit = (value: string) => done(value);
  input.onEscape = () => done(undefined);

  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => input.handleInput(data),
  };
}

/** A submenu of on/off toggles for choosing which metrics the footer shows. */
function segmentsSubmenu(config: GovernorConfig, done: (value?: string) => void): Component {
  const itemId = (segment: StatusSegment) => `segment.${segment}`;
  const selected = new Set<StatusSegment>(config.status.segments);

  const items: SettingItem[] = SEGMENT_LABELS.map(({ segment, label }) => ({
    id: itemId(segment),
    label,
    currentValue: selected.has(segment) ? "on" : "off",
    values: ["on", "off"],
  }));

  const commit = () => {
    const ordered = SEGMENT_LABELS.filter((entry) => selected.has(entry.segment)).map((entry) => entry.segment);
    done(ordered.join(","));
  };

  const container = new Container();
  container.addChild(new Text("Status line metrics", 1, 1));

  const list = new SettingsList(
    items,
    Math.min(items.length + 2, 12),
    getSettingsListTheme(),
    (id, newValue) => {
      const segment = id.replace("segment.", "") as StatusSegment;
      if (newValue === "on") selected.add(segment);
      else selected.delete(segment);
      commit();
    },
    () => commit(),
    { enableSearch: false },
  );

  container.addChild(list);

  return {
    render: (width: number) => container.render(width),
    invalidate: () => container.invalidate(),
    handleInput: (data: string) => list.handleInput(data),
  };
}

/**
 * Open the panel. Resolves when the user closes it.
 * Changes are applied as they are made; there is no confirm step.
 */
export async function openGovernorPanel(ctx: ExtensionContext, options: PanelOptions): Promise<void> {
  // The panel owns a mutable view of the config that it applies patches onto,
  // so re-opening a row shows the value the user just chose.
  let config = options.config;

  const apply = (patch: GovernorConfigPatch): void => {
    options.onChange(patch);
    config = mergeInto(config, patch);
  };

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const container = new Container();

    const header = new Text("", 1, 1);
    const renderHeader = () => {
      header.setText(
        [
          theme.fg("accent", theme.bold("pi-governor")),
          theme.fg("dim", "↑↓ move · Enter change · Esc close"),
          theme.fg("dim", `saving to ${options.targetPath}`),
        ].join("\n"),
      );
    };
    renderHeader();
    container.addChild(header);

    const buildItems = (): SettingItem[] => {
      const items: SettingItem[] = [];

      for (const spec of NUMERIC_SPECS) {
        items.push({
          id: spec.id,
          label: spec.label,
          description: spec.description,
          currentValue: displayValue(spec.id, config),
          submenu: (_current, submenuDone) => numericSubmenu(spec, config, submenuDone),
        });
      }

      items.push({
        id: "misc.timeMode",
        label: "Time limit counts",
        description: "Wall clock, or only time spent inside agent runs",
        currentValue: displayValue("misc.timeMode", config),
        values: [...TIME_MODES],
      });

      items.push({
        id: "misc.warnRatio",
        label: "Warn at",
        description: "Fraction of a limit at which warnings begin",
        currentValue: displayValue("misc.warnRatio", config),
        values: ["50%", "60%", "70%", "75%", "80%", "90%", "95%"],
      });

      for (const spec of ENFORCEMENT_SPECS) {
        items.push({
          id: spec.id,
          label: spec.label,
          description: spec.description,
          currentValue: displayValue(spec.id, config),
          values: [...spec.values],
        });
      }

      items.push({
        id: "preflight.enabled",
        label: "Forecast next turn",
        description: "Price the next turn before it is spent, so cost limits cannot overshoot",
        currentValue: displayValue("preflight.enabled", config),
        values: ["on", "off"],
      });

      items.push({
        id: "preflight.assumedOutputTokens",
        label: "Forecast output tokens",
        description: "Output tokens to assume when pricing the next turn",
        currentValue: displayValue("preflight.assumedOutputTokens", config),
        values: ["2000", "4000", "8000", "16000", "32000"],
      });

      items.push({
        id: "preflight.useCacheEstimate",
        label: "Forecast uses cache rate",
        description: "Credit the observed cache hit rate; off assumes a cold cache (worst case)",
        currentValue: displayValue("preflight.useCacheEstimate", config),
        values: ["on", "off"],
      });

      items.push({
        id: "status.enabled",
        label: "Status line",
        description: "Show the compact governor indicator in the footer",
        currentValue: displayValue("status.enabled", config),
        values: ["on", "off"],
      });

      items.push({
        id: "status.segments",
        label: "Status metrics",
        description: "Which metrics appear in the footer status line",
        currentValue: displayValue("status.segments", config),
        submenu: (_current, submenuDone) => segmentsSubmenu(config, submenuDone),
      });

      return items;
    };

    const list = new SettingsList(
      buildItems(),
      18,
      getSettingsListTheme(),
      (id, newValue) => {
        const patch = patchFor(id, newValue, config);
        if (!patch) return;
        apply(patch);
        list.updateValue(id, displayValue(id, config));
        renderHeader();
        tui.requestRender();
      },
      () => done(undefined),
      { enableSearch: true },
    );

    container.addChild(list);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      // Escape is handled by SettingsList itself: at the top level it calls
      // onCancel, and inside a submenu it closes just the submenu. Intercepting
      // escape here would close the whole panel while a submenu is open.
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

/** Local deep-merge mirroring `mergeConfig`, used to keep the panel in sync. */
function mergeInto(config: GovernorConfig, patch: GovernorConfigPatch): GovernorConfig {
  return {
    enabled: patch.enabled ?? config.enabled,
    warnRatio: patch.warnRatio ?? config.warnRatio,
    timeMode: patch.timeMode ?? config.timeMode,
    exposeTool: patch.exposeTool ?? config.exposeTool,
    limits: { ...config.limits, ...(patch.limits ?? {}) },
    enforcement: { ...config.enforcement, ...(patch.enforcement ?? {}) },
    preflight: { ...config.preflight, ...(patch.preflight ?? {}) },
    status: { ...config.status, ...(patch.status ?? {}) },
  };
}

export { NUMERIC_SPECS };

/** Limit keys the panel can drive, for documentation and tests. */
export const PANEL_LIMIT_KEYS: readonly LimitKey[] = ["cost", "time", "context", "tokens", "turns"];
