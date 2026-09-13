/**
 * Layered configuration for pi-governor.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. `<agentDir>/governor.json`      (global)
 *   3. `<cwd>/<configDirName>/governor.json`  (project, only when trusted)
 *   4. CLI flags (`--governor-*`)
 *
 * Everything here is pure apart from reading the two files, and the agent
 * directory / project config directory are injected by the caller so this
 * module never has to import the pi runtime.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  STATUS_SEGMENTS,
  type GovernorConfig,
  type GovernorEnforcement,
  type GovernorLimits,
  type GovernorPreflight,
  type GovernorStatusConfig,
  type StatusSegment,
} from "./types.ts";

export const CONFIG_FILE_NAME = "governor.json";

export const DEFAULT_CONFIG: GovernorConfig = {
  enabled: true,
  warnRatio: 0.8,
  timeMode: "wall",
  limits: {
    timeMinutes: null,
    costUsd: null,
    contextPercent: null,
    totalTokens: null,
    turns: null,
  },
  enforcement: {
    enabled: true,
    onToolCall: "block",
    onPrompt: "refuse",
    // "allow", not "abort": blocking tool calls already forces a tool-free
    // wrap-up turn, which stops the work *and* lets the model tell the user why.
    // Aborting threw that final message away. Opt into "abort" for a hard stop
    // on money/time budgets, where even a wrap-up turn is unwanted spend.
    onTurn: "allow",
    onContext: "compact",
    onPreflight: "warn",
  },
  preflight: {
    enabled: true,
    assumedOutputTokens: 8000,
    useCacheEstimate: true,
  },
  status: {
    enabled: true,
    segments: ["cost", "context", "time", "turns"],
    updateIntervalMs: 1000,
  },
  exposeTool: false,
};

type LimitField = keyof GovernorLimits;

/** Numeric bounds for each limit, used for validation. */
const LIMIT_SPECS: ReadonlyArray<{ key: LimitField; min: number; max: number }> = [
  { key: "timeMinutes", min: 0.1, max: 100_000 },
  { key: "costUsd", min: 0.0001, max: 10_000_000 },
  { key: "contextPercent", min: 1, max: 100 },
  { key: "totalTokens", min: 1, max: 1_000_000_000_000 },
  { key: "turns", min: 1, max: 10_000_000 },
];
type LimitPatch = Partial<GovernorLimits>;

export interface GovernorFlagOverrides {
  off?: boolean;
  observe?: boolean;
  exposeTool?: boolean;
  preflight?: string;
  maxTime?: string;
  maxCost?: string;
  maxContext?: string;
  maxTokens?: string;
  maxTurns?: string;
}

/**
 * A deep-partial config used while layering sources. `Partial<GovernorConfig>`
 * is not enough because it makes the nested sections required again.
 */
export interface GovernorConfigPatch {
  enabled?: boolean;
  warnRatio?: number;
  timeMode?: "wall" | "active";
  exposeTool?: boolean;
  limits?: LimitPatch;
  enforcement?: Partial<GovernorEnforcement>;
  preflight?: Partial<GovernorPreflight>;
  status?: Partial<GovernorStatusConfig>;
}

export interface ResolveConfigOptions {
  cwd: string;
  agentDir: string;
  configDirName: string;
  projectTrusted: boolean;
  flags?: GovernorFlagOverrides;
}

export interface ConfigLoadResult {
  config: GovernorConfig;
  /** Config files that were read successfully. */
  loaded: string[];
  /** Candidate config files that do not exist. */
  missing: string[];
  /** Human-readable validation problems, if any. */
  diagnostics: string[];
}

export function globalConfigPath(agentDir: string): string {
  return join(agentDir, CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string, configDirName: string): string {
  return join(cwd, configDirName, CONFIG_FILE_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseLimit(
  raw: Record<string, unknown>,
  field: LimitField,
  where: string,
  min: number,
  max: number,
  diagnostics: string[],
): number | null | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    diagnostics.push(`${where}: limits.${field} must be a number or null (got ${JSON.stringify(value)})`);
    return undefined;
  }
  if (value < min || value > max) {
    diagnostics.push(`${where}: limits.${field} must be between ${min} and ${max} (got ${value})`);
    return undefined;
  }
  return value;
}

function parseBoolean(
  raw: Record<string, unknown>,
  field: string,
  where: string,
  diagnostics: string[],
): boolean | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    diagnostics.push(`${where}: ${field} must be a boolean (got ${JSON.stringify(value)})`);
    return undefined;
  }
  return value;
}

function parseChoice<T extends string>(
  raw: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  where: string,
  diagnostics: string[],
): T | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    diagnostics.push(`${where}: ${field} must be one of ${allowed.join(", ")} (got ${JSON.stringify(value)})`);
    return undefined;
  }
  return value as T;
}

function parseNumberInRange(
  raw: Record<string, unknown>,
  field: string,
  min: number,
  max: number,
  where: string,
  diagnostics: string[],
): number | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    diagnostics.push(`${where}: ${field} must be a number (got ${JSON.stringify(value)})`);
    return undefined;
  }
  if (value < min || value > max) {
    diagnostics.push(`${where}: ${field} must be between ${min} and ${max} (got ${value})`);
    return undefined;
  }
  return value;
}

function parseSegments(
  raw: Record<string, unknown>,
  field: string,
  where: string,
  diagnostics: string[],
): StatusSegment[] | undefined {
  const value = raw[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    diagnostics.push(`${where}: ${field} must be an array (got ${JSON.stringify(value)})`);
    return undefined;
  }
  const out: StatusSegment[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !STATUS_SEGMENTS.includes(entry as StatusSegment)) {
      diagnostics.push(`${where}: ${field} contains an unknown segment ${JSON.stringify(entry)}`);
      continue;
    }
    const segment = entry as StatusSegment;
    if (!out.includes(segment)) out.push(segment);
  }
  return out;
}

/**
 * Validate one config file's parsed JSON into a partial config.
 * Never throws: unknown or malformed values are reported and skipped.
 */
export function parseConfig(raw: unknown, origin: string, diagnostics: string[]): GovernorConfigPatch {
  if (!isRecord(raw)) {
    diagnostics.push(`${origin}: expected a JSON object at the top level`);
    return {};
  }

  const patch: GovernorConfigPatch = {};

  const enabled = parseBoolean(raw, "enabled", origin, diagnostics);
  if (enabled !== undefined) patch.enabled = enabled;

  const warnRatio = parseNumberInRange(raw, "warnRatio", 0.05, 1, origin, diagnostics);
  if (warnRatio !== undefined) patch.warnRatio = warnRatio;

  const timeMode = parseChoice(raw, "timeMode", ["wall", "active"] as const, origin, diagnostics);
  if (timeMode !== undefined) patch.timeMode = timeMode;

  const exposeTool = parseBoolean(raw, "exposeTool", origin, diagnostics);
  if (exposeTool !== undefined) patch.exposeTool = exposeTool;

  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) {
      diagnostics.push(`${origin}: limits must be an object`);
    } else {
      const limits: LimitPatch = {};
      for (const spec of LIMIT_SPECS) {
        const value = parseLimit(raw.limits, spec.key, origin, spec.min, spec.max, diagnostics);
        if (value !== undefined) limits[spec.key] = value;
      }
      patch.limits = limits;
    }
  }

  if (raw.enforcement !== undefined) {
    if (!isRecord(raw.enforcement)) {
      diagnostics.push(`${origin}: enforcement must be an object`);
    } else {
      const enforcement: Partial<GovernorEnforcement> = {};
      const enforcementEnabled = parseBoolean(raw.enforcement, "enabled", origin, diagnostics);
      if (enforcementEnabled !== undefined) enforcement.enabled = enforcementEnabled;
      const onToolCall = parseChoice(raw.enforcement, "onToolCall", ["block", "allow"] as const, origin, diagnostics);
      if (onToolCall !== undefined) enforcement.onToolCall = onToolCall;
      const onPrompt = parseChoice(raw.enforcement, "onPrompt", ["refuse", "allow"] as const, origin, diagnostics);
      if (onPrompt !== undefined) enforcement.onPrompt = onPrompt;
      const onTurn = parseChoice(raw.enforcement, "onTurn", ["abort", "allow"] as const, origin, diagnostics);
      if (onTurn !== undefined) enforcement.onTurn = onTurn;
      const onContext = parseChoice(raw.enforcement, "onContext", ["compact", "observe"] as const, origin, diagnostics);
      if (onContext !== undefined) enforcement.onContext = onContext;
      const onPreflight = parseChoice(raw.enforcement, "onPreflight", ["warn", "refuse"] as const, origin, diagnostics);
      if (onPreflight !== undefined) enforcement.onPreflight = onPreflight;
      patch.enforcement = enforcement;
    }
  }

  if (raw.preflight !== undefined) {
    if (!isRecord(raw.preflight)) {
      diagnostics.push(`${origin}: preflight must be an object`);
    } else {
      const preflight: Partial<GovernorPreflight> = {};
      const preflightEnabled = parseBoolean(raw.preflight, "enabled", origin, diagnostics);
      if (preflightEnabled !== undefined) preflight.enabled = preflightEnabled;
      const assumedOutputTokens = parseNumberInRange(
        raw.preflight,
        "assumedOutputTokens",
        1,
        1_000_000,
        origin,
        diagnostics,
      );
      if (assumedOutputTokens !== undefined) preflight.assumedOutputTokens = assumedOutputTokens;
      const useCacheEstimate = parseBoolean(raw.preflight, "useCacheEstimate", origin, diagnostics);
      if (useCacheEstimate !== undefined) preflight.useCacheEstimate = useCacheEstimate;
      patch.preflight = preflight;
    }
  }

  if (raw.status !== undefined) {
    if (!isRecord(raw.status)) {
      diagnostics.push(`${origin}: status must be an object`);
    } else {
      const status: Partial<GovernorStatusConfig> = {};
      const statusEnabled = parseBoolean(raw.status, "enabled", origin, diagnostics);
      if (statusEnabled !== undefined) status.enabled = statusEnabled;
      const segments = parseSegments(raw.status, "segments", origin, diagnostics);
      if (segments !== undefined) status.segments = segments;
      const updateIntervalMs = parseNumberInRange(raw.status, "updateIntervalMs", 250, 60_000, origin, diagnostics);
      if (updateIntervalMs !== undefined) status.updateIntervalMs = updateIntervalMs;
      patch.status = status;
    }
  }

  return patch;
}

/** Deep-merge a validated patch onto a complete config. */
export function mergeConfig(base: GovernorConfig, patch: GovernorConfigPatch): GovernorConfig {
  return {
    enabled: patch.enabled ?? base.enabled,
    warnRatio: patch.warnRatio ?? base.warnRatio,
    timeMode: patch.timeMode ?? base.timeMode,
    exposeTool: patch.exposeTool ?? base.exposeTool,
    limits: { ...base.limits, ...(patch.limits ?? {}) },
    enforcement: { ...base.enforcement, ...(patch.enforcement ?? {}) },
    preflight: { ...base.preflight, ...(patch.preflight ?? {}) },
    status: { ...base.status, ...(patch.status ?? {}) },
  };
}

function parseFlagNumber(
  value: string | undefined,
  name: string,
  min: number,
  max: number,
  diagnostics: string[],
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    diagnostics.push(`--${name}: expected a number (got ${JSON.stringify(value)})`);
    return undefined;
  }
  if (parsed < min || parsed > max) {
    diagnostics.push(`--${name}: ${parsed} is outside the allowed range ${min}..${max}`);
    return undefined;
  }
  return parsed;
}

/** Apply CLI flag overrides on top of file configuration. */
export function applyFlagOverrides(
  config: GovernorConfig,
  flags: GovernorFlagOverrides,
  diagnostics: string[],
): GovernorConfig {
  let next = config;
  const limits: LimitPatch = {};

  const time = parseFlagNumber(flags.maxTime, "governor-max-time", 0.1, 100_000, diagnostics);
  if (time !== undefined) limits.timeMinutes = time;

  const cost = parseFlagNumber(flags.maxCost, "governor-max-cost", 0.0001, 10_000_000, diagnostics);
  if (cost !== undefined) limits.costUsd = cost;

  const context = parseFlagNumber(flags.maxContext, "governor-max-context", 1, 100, diagnostics);
  if (context !== undefined) limits.contextPercent = context;

  const tokens = parseFlagNumber(flags.maxTokens, "governor-max-tokens", 1, 1_000_000_000_000, diagnostics);
  if (tokens !== undefined) limits.totalTokens = tokens;

  const turns = parseFlagNumber(flags.maxTurns, "governor-max-turns", 1, 10_000_000, diagnostics);
  if (turns !== undefined) limits.turns = turns;

  if (Object.keys(limits).length > 0) {
    next = mergeConfig(next, { limits });
  }

  if (flags.off === true) next = mergeConfig(next, { enabled: false });
  if (flags.observe === true) next = mergeConfig(next, { enforcement: { enabled: false } });
  if (flags.exposeTool === true) next = mergeConfig(next, { exposeTool: true });

  if (flags.preflight !== undefined && flags.preflight !== "") {
    switch (flags.preflight) {
      case "off":
        next = mergeConfig(next, { preflight: { enabled: false } });
        break;
      case "warn":
      case "refuse":
        next = mergeConfig(next, { preflight: { enabled: true }, enforcement: { onPreflight: flags.preflight } });
        break;
      default:
        diagnostics.push(`--governor-preflight: expected off, warn, or refuse (got ${JSON.stringify(flags.preflight)})`);
        break;
    }
  }

  return next;
}

function readJsonFile(path: string, diagnostics: string[]): unknown | undefined {
  if (!existsSync(path)) return undefined;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    diagnostics.push(`${path}: could not be read (${(error as Error).message})`);
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    diagnostics.push(`${path}: invalid JSON (${(error as Error).message})`);
    return undefined;
  }
}

/**
 * Resolve the effective configuration from defaults, files, and flags.
 * Project configuration is only honoured when the project is trusted.
 */
export function loadConfig(options: ResolveConfigOptions): ConfigLoadResult {
  const diagnostics: string[] = [];
  const loaded: string[] = [];
  const missing: string[] = [];

  let config = DEFAULT_CONFIG;

  const globalPath = globalConfigPath(options.agentDir);
  const globalRaw = readJsonFile(globalPath, diagnostics);
  if (globalRaw === undefined) {
    if (!existsSync(globalPath)) missing.push(globalPath);
  } else {
    loaded.push(globalPath);
    config = mergeConfig(config, parseConfig(globalRaw, globalPath, diagnostics));
  }

  const projectPath = projectConfigPath(options.cwd, options.configDirName);
  if (options.projectTrusted) {
    const projectRaw = readJsonFile(projectPath, diagnostics);
    if (projectRaw === undefined) {
      if (!existsSync(projectPath)) missing.push(projectPath);
    } else {
      loaded.push(projectPath);
      config = mergeConfig(config, parseConfig(projectRaw, projectPath, diagnostics));
    }
  }

  config = applyFlagOverrides(config, options.flags ?? {}, diagnostics);

  // Belt and braces: warnRatio is used as a divisor-free multiplier downstream,
  // so clamp it even if a future code path skips validation.
  if (!Number.isFinite(config.warnRatio) || config.warnRatio <= 0 || config.warnRatio > 1) {
    config = mergeConfig(config, { warnRatio: DEFAULT_CONFIG.warnRatio });
  }

  return { config, loaded, missing, diagnostics };
}

/**
 * Merge a patch into the raw JSON of a config file, preserving keys this
 * version of the governor does not understand and any `$schema` reference.
 *
 * Writing the validated config instead would silently discard unknown fields,
 * so the raw document is the source of truth for writes.
 */
export function mergeRawConfig(existing: unknown, patch: GovernorConfigPatch): Record<string, unknown> {
  const base: Record<string, unknown> = isRecord(existing) ? { ...existing } : {};

  const assign = (key: string, value: unknown): void => {
    if (value !== undefined) base[key] = value;
  };

  assign("enabled", patch.enabled);
  assign("warnRatio", patch.warnRatio);
  assign("timeMode", patch.timeMode);
  assign("exposeTool", patch.exposeTool);

  const mergeSection = (key: string, section: Record<string, unknown> | undefined): void => {
    if (!section) return;
    const current = isRecord(base[key]) ? (base[key] as Record<string, unknown>) : {};
    base[key] = { ...current, ...section };
  };

  mergeSection("limits", patch.limits as Record<string, unknown> | undefined);
  mergeSection("enforcement", patch.enforcement as Record<string, unknown> | undefined);
  mergeSection("preflight", patch.preflight as Record<string, unknown> | undefined);
  mergeSection("status", patch.status as Record<string, unknown> | undefined);

  return base;
}

export interface WriteConfigResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * Apply a patch to a config file on disk, creating it when absent.
 * Never throws: failures are returned so the caller can surface them in the UI.
 */
export function writeConfigFile(path: string, patch: GovernorConfigPatch): WriteConfigResult {
  let existing: unknown;
  if (existsSync(path)) {
    try {
      const text = readFileSync(path, "utf8");
      existing = text.trim() === "" ? {} : (JSON.parse(text) as unknown);
    } catch (error) {
      return { ok: false, path, error: `could not read existing config: ${(error as Error).message}` };
    }
  }

  const merged = mergeRawConfig(existing, patch);

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  } catch (error) {
    return { ok: false, path, error: (error as Error).message };
  }

  return { ok: true, path };
}
