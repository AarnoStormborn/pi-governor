/**
 * Integration tests for the wiring layer.
 *
 * These drive the real extension factory with a stubbed `ExtensionAPI` and a
 * stubbed `ExtensionContext`, so the enforcement contract (block, refuse,
 * abort, compact) is verified without a model or a live session.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import piGovernor from "../src/index.ts";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-governor-project-"));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** Rates for commandcode/deepseek-v4-flash. */
const PRICED_MODEL = {
  id: "deepseek-v4-flash",
  provider: "commandcode",
  cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
};

/** A model the provider never priced — all rates zero. */
const UNPRICED_MODEL = {
  id: "brand-new-model",
  provider: "commandcode",
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown;

interface Harness {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  sessionEntries: unknown[];
  statuses: Map<string, string | undefined>;
  notifications: string[];
  aborts: number;
  compactions: unknown[];
  tools: Record<string, unknown>[];
  commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  component: { render(width: number): string[]; handleInput(data: string): void } | null;
  componentClosed: boolean;
  componentClosedWith: unknown;
  dispatch: (event: string, payload?: Record<string, unknown>) => Promise<unknown[]>;
}

function createHarness(
  flags: Record<string, boolean | string> = {},
  contextUsage: { tokens: number; contextWindow: number; percent: number } | undefined = {
    tokens: 100_000,
    contextWindow: 200_000,
    percent: 50,
  },
  options: { model?: unknown; trusted?: boolean; cwd?: string; projectConfig?: Record<string, unknown> } = {},
): Harness {
  const handlers = new Map<string, Handler[]>();
  const sessionEntries: unknown[] = [];
  const statuses = new Map<string, string | undefined>();
  const notifications: string[] = [];
  const tools: Record<string, unknown>[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const compactions: unknown[] = [];
  let aborts = 0;
  /** Component captured from the most recent `ctx.ui.custom()` call. */
  let capturedComponent: { render(width: number): string[]; handleInput(data: string): void } | null = null;
  let capturedClosed = false;
  let capturedClosedWith: unknown = undefined;

  // Materialise a project config file so tests can exercise layers that have no
  // CLI flag (enforcement actions, preflight tuning, ...).
  const cwd = options.cwd ?? "/tmp/pi-governor-test";
  if (options.projectConfig) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "governor.json"), JSON.stringify(options.projectConfig), "utf8");
  }

  const pi = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerFlag() {},
    getFlag(name: string) {
      return flags[name];
    },
    registerTool(tool: Record<string, unknown>) {
      tools.push(tool);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, options);
    },
    appendEntry() {},
    getActiveTools: () => [],
    getAllTools: () => [],
  };

  const ctx = {
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      notify: (message: string) => {
        notifications.push(message);
      },
      setStatus: (key: string, text: string | undefined) => {
        statuses.set(key, text);
      },
      custom: (
        factory: (tui: unknown, theme: unknown, kb: unknown, done: (value: unknown) => void) => unknown,
      ) => {
        const stubTheme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
        capturedComponent = factory({ requestRender: () => {} }, stubTheme, {}, (value: unknown) => {
          capturedClosed = true;
          capturedClosedWith = value;
        }) as { render(width: number): string[]; handleInput(data: string): void };
        return Promise.resolve(undefined);
      },
    },
    mode: "tui",
    hasUI: true,
    cwd,
    model: options.model,
    isProjectTrusted: () => options.trusted ?? Boolean(options.projectConfig),
    sessionManager: {
      getEntries: () => sessionEntries,
      getHeader: () => ({
        type: "session",
        version: 3,
        id: "test-session",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
        cwd: "/tmp/pi-governor-test",
      }),
    },
    getContextUsage: () => contextUsage,
    abort: () => {
      aborts += 1;
    },
    compact: (options2: unknown) => {
      compactions.push(options2);
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    shutdown: () => {},
    getSystemPrompt: () => "",
  };

  const dispatch = async (event: string, payload: Record<string, unknown> = {}): Promise<unknown[]> => {
    const results: unknown[] = [];
    for (const handler of handlers.get(event) ?? []) {
      results.push(await handler({ type: event, ...payload }, ctx));
    }
    return results;
  };

  return {
    pi: pi as unknown as ExtensionAPI,
    ctx: ctx as unknown as ExtensionContext,
    sessionEntries,
    statuses,
    notifications,
    get aborts() {
      return aborts;
    },
    compactions,
    tools,
    commands,
    get component() {
      return capturedComponent;
    },
    get componentClosed() {
      return capturedClosed;
    },
    get componentClosedWith() {
      return capturedClosedWith;
    },
    dispatch,
  } as Harness & { aborts: number };
}

function assistantEntry(options: { cost?: number; tokens?: number; stopReason?: string; toolCalls?: number } = {}) {
  const { cost = 0, tokens = 100, stopReason = "stop", toolCalls = 0 } = options;
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
          name: "bash",
          arguments: {},
        })),
        { type: "text" as const, text: "ok" },
      ],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "test",
      usage: {
        input: tokens,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: tokens,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
      },
      stopReason,
      timestamp: 1,
    },
  };
}

describe("pi-governor wiring", () => {
  it("stays inert when no budget is configured", async () => {
    const harness = createHarness();
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 99 }));

    await harness.dispatch("session_start");
    assert.equal(harness.statuses.get("governor"), "⚖ unconfigured");

    const results = await harness.dispatch("tool_call", { toolName: "bash", input: {} });
    assert.deepEqual(results, [undefined]);

    await harness.dispatch("session_shutdown");
  });

  it("renders the configured budgets in the footer", async () => {
    const harness = createHarness({ "governor-max-cost": "5" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 1.25 }));

    await harness.dispatch("session_start");
    // Unconfigured segments still show their value, just without a budget.
    assert.equal(harness.statuses.get("governor"), "⚖ $1.25/$5.00 · ctx 50% · 1m · 1t");

    await harness.dispatch("session_shutdown");
  });

  it("blocks tool calls once a budget is exceeded", async () => {
    const harness = createHarness({ "governor-max-cost": "1" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 1.5 }));

    await harness.dispatch("session_start");
    const results = await harness.dispatch("tool_call", { toolName: "bash", input: {} });

    assert.equal(results.length, 1);
    const result = results[0] as { block: boolean; reason: string; terminate?: boolean };
    assert.equal(result.block, true);
    assert.match(result.reason, /session cost budget exceeded/);
    // Deliberately not terminating: the block must reach the model as a tool
    // result so it can explain. `terminate: true` produced empty output in a
    // real print-mode run.
    assert.equal(result.terminate, undefined);

    await harness.dispatch("session_shutdown");
  });

  it("allows tool calls while a budget is merely close", async () => {
    const harness = createHarness({ "governor-max-cost": "5" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 4.5 }));

    await harness.dispatch("session_start");
    // Warnings are evaluated as turns complete.
    await harness.dispatch("turn_end", { turnIndex: 0, toolResults: [] });

    assert.deepEqual(await harness.dispatch("tool_call", { toolName: "bash", input: {} }), [undefined]);
    assert.equal(harness.aborts, 0);
    // 90% of budget, past the default 80% warn ratio.
    assert.ok(
      harness.notifications.some((line) => /session cost at 90% of budget/.test(line)),
      harness.notifications.join("\n"),
    );

    await harness.dispatch("session_shutdown");
  });

  it("refuses prompts once a budget is exceeded", async () => {
    const harness = createHarness({ "governor-max-cost": "1" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 2 }));

    await harness.dispatch("session_start");
    const results = await harness.dispatch("input", { text: "keep going", source: "interactive" });
    assert.deepEqual(results, [{ action: "handled" }]);

    await harness.dispatch("session_shutdown");
  });

  it("does not refuse prompts that came from an extension", async () => {
    const harness = createHarness({ "governor-max-cost": "1" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 2 }));

    await harness.dispatch("session_start");
    const results = await harness.dispatch("input", { text: "internal", source: "extension" });
    assert.deepEqual(results, [{ action: "continue" }]);

    await harness.dispatch("session_shutdown");
  });

  it("observes without enforcing when --governor-observe is set", async () => {
    const harness = createHarness({ "governor-max-cost": "1", "governor-observe": true });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 2 }));

    await harness.dispatch("session_start");
    assert.deepEqual(await harness.dispatch("tool_call", { toolName: "bash", input: {} }), [undefined]);
    assert.deepEqual(await harness.dispatch("input", { text: "go", source: "interactive" }), [
      { action: "continue" },
    ]);

    await harness.dispatch("session_shutdown");
  });

  it("does nothing at all when --governor-off is set", async () => {
    const harness = createHarness({ "governor-max-cost": "1", "governor-off": true });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 5 }));

    await harness.dispatch("session_start");
    assert.equal(harness.statuses.get("governor"), undefined);
    assert.deepEqual(await harness.dispatch("tool_call", { toolName: "bash", input: {} }), [undefined]);

    await harness.dispatch("session_shutdown");
  });

  it("aborts a turn and compacts once when the context ceiling is crossed", async () => {
    // `abort` is opt-in; enable it explicitly here.
    const harness = createHarness({ "governor-max-context": "40" }, undefined, {
      projectConfig: { enforcement: { onTurn: "abort" } },
    });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry());

    await harness.dispatch("session_start");
    await harness.dispatch("turn_end", { turnIndex: 0, toolResults: [] });
    await harness.dispatch("turn_end", { turnIndex: 1, toolResults: [] });

    assert.equal(harness.aborts, 2, "abort is requested on each over-budget turn");
    assert.equal(harness.compactions.length, 1, "compaction only fires on the crossing");

    await harness.dispatch("session_shutdown");
  });

  it("does not abort by default, because blocking tools already stops the work", async () => {
    const harness = createHarness({ "governor-max-context": "40" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry());

    await harness.dispatch("session_start");
    await harness.dispatch("turn_end", { turnIndex: 0, toolResults: [] });

    assert.equal(harness.aborts, 0);

    await harness.dispatch("session_shutdown");
  });

  it("does not compact while the context ceiling is respected", async () => {
    const harness = createHarness({ "governor-max-context": "90" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry());

    await harness.dispatch("session_start");
    await harness.dispatch("turn_end", { turnIndex: 0, toolResults: [] });

    assert.equal(harness.compactions.length, 0);
    assert.equal(harness.aborts, 0);

    await harness.dispatch("session_shutdown");
  });

  it("pause halts enforcement without stopping measurement", async () => {
    const harness = createHarness({ "governor-max-cost": "1" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 2 }));

    await harness.dispatch("session_start");
    assert.notDeepEqual(await harness.dispatch("tool_call", { toolName: "bash", input: {} }), [undefined]);

    const governor = harness.commands.get("governor");
    assert.ok(governor, "/governor must be registered");
    await governor.handler("pause", harness.ctx);

    assert.deepEqual(await harness.dispatch("tool_call", { toolName: "bash", input: {} }), [undefined]);
    assert.match(harness.statuses.get("governor") ?? "", /⏸/);

    await governor.handler("resume", harness.ctx);
    assert.notDeepEqual(await harness.dispatch("tool_call", { toolName: "bash", input: {} }), [undefined]);

    await harness.dispatch("session_shutdown");
  });

  it("registers the status tool only when exposeTool is on", async () => {
    const off = createHarness();
    piGovernor(off.pi);
    await off.dispatch("session_start");
    assert.equal(off.tools.length, 0);
    await off.dispatch("session_shutdown");

    const on = createHarness({ "governor-max-cost": "5", "governor-tool": true });
    piGovernor(on.pi);
    await on.dispatch("session_start");
    assert.equal(on.tools.length, 1, "governor_status should be registered once");

    const tool = on.tools[0] as {
      name: string;
      execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: unknown }>;
    };
    assert.equal(tool.name, "governor_status");

    const result = await tool.execute("call-1", {}, undefined, undefined, on.ctx);
    const payload = result.details as { enforcing: boolean; limits: { key: string; status: string }[] };
    assert.equal(payload.enforcing, true);
    assert.equal(payload.limits[0]?.key, "cost");
    assert.equal(payload.limits[0]?.status, "ok");

    await on.dispatch("session_shutdown");
  });

  it("clears the footer status on shutdown", async () => {
    const harness = createHarness({ "governor-max-cost": "5" });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");
    assert.ok(harness.statuses.get("governor"));

    await harness.dispatch("session_shutdown");
    assert.equal(harness.statuses.get("governor"), undefined);
  });
});

describe("zero-cost detection (fix 1)", () => {
  it("warns when a cost limit is set on an unpriced model", async () => {
    const harness = createHarness({ "governor-max-cost": "5" }, undefined, { model: UNPRICED_MODEL });
    piGovernor(harness.pi);

    await harness.dispatch("session_start");

    const warning = harness.notifications.find((line) => /cost limit cannot fire/.test(line));
    assert.ok(warning, harness.notifications.join("\n"));
    assert.match(warning, /commandcode\/brand-new-model/);
    assert.match(warning, /no pricing data/);

    await harness.dispatch("session_shutdown");
  });

  it("stays quiet when the model is priced", async () => {
    const harness = createHarness({ "governor-max-cost": "5" }, undefined, { model: PRICED_MODEL });
    piGovernor(harness.pi);

    await harness.dispatch("session_start");

    assert.equal(
      harness.notifications.some((line) => /cost limit cannot fire/.test(line)),
      false,
      harness.notifications.join("\n"),
    );

    await harness.dispatch("session_shutdown");
  });

  it("stays quiet when no cost limit is configured", async () => {
    const harness = createHarness({}, undefined, { model: UNPRICED_MODEL });
    piGovernor(harness.pi);

    await harness.dispatch("session_start");

    assert.equal(harness.notifications.some((line) => /cost limit cannot fire/.test(line)), false);

    await harness.dispatch("session_shutdown");
  });

  it("re-checks the warning when the model changes", async () => {
    const harness = createHarness({ "governor-max-cost": "5" }, undefined, { model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    // Swap in an unpriced model, as /model would.
    (harness.ctx as unknown as { model: unknown }).model = UNPRICED_MODEL;
    await harness.dispatch("model_select");

    assert.ok(harness.notifications.some((line) => /cost limit cannot fire/.test(line)));

    await harness.dispatch("session_shutdown");
  });
});

describe("pre-flight cost projection (fix 3)", () => {
  const expensiveUsage = (cost: number) => assistantEntry({ cost, tokens: 10_000 });

  it("refuses a turn that is forecast to cross the cost limit", async () => {
    // 500k context at $0.22/M plus max-output assumption stays cheap, so use a
    // model whose rates make one turn expensive relative to the budget.
    const harness = createHarness(
      { "governor-max-cost": "0.05", "governor-preflight": "refuse" },
      { tokens: 500_000, contextWindow: 1_000_000, percent: 50 },
      { model: { ...PRICED_MODEL, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } } },
    );
    piGovernor(harness.pi);
    harness.sessionEntries.push(expensiveUsage(0));

    await harness.dispatch("session_start");
    const results = await harness.dispatch("input", { text: "keep going", source: "interactive" });

    assert.deepEqual(results, [{ action: "handled" }]);
    assert.ok(
      harness.notifications.some((line) => /forecast to cost/.test(line)),
      harness.notifications.join("\n"),
    );

    await harness.dispatch("session_shutdown");
  });

  it("allows the turn when pre-flight only warns", async () => {
    const harness = createHarness(
      { "governor-max-cost": "0.05" },
      { tokens: 500_000, contextWindow: 1_000_000, percent: 50 },
      { model: { ...PRICED_MODEL, cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 } } },
    );
    piGovernor(harness.pi);
    harness.sessionEntries.push(expensiveUsage(0));

    await harness.dispatch("session_start");
    assert.deepEqual(await harness.dispatch("input", { text: "go", source: "interactive" }), [
      { action: "continue" },
    ]);
    // The forecast is still visible in the status line.
    assert.match(harness.statuses.get("governor") ?? "", /→\$/);

    await harness.dispatch("session_shutdown");
  });

  it("allows the turn when the forecast fits the budget", async () => {
    const harness = createHarness(
      { "governor-max-cost": "50", "governor-preflight": "refuse" },
      { tokens: 1_000, contextWindow: 200_000, percent: 1 },
      { model: PRICED_MODEL },
    );
    piGovernor(harness.pi);
    harness.sessionEntries.push(expensiveUsage(0));

    await harness.dispatch("session_start");
    assert.deepEqual(await harness.dispatch("input", { text: "go", source: "interactive" }), [
      { action: "continue" },
    ]);

    await harness.dispatch("session_shutdown");
  });

  it("never blocks on an unpriced model, where no forecast exists", async () => {
    const harness = createHarness(
      { "governor-max-cost": "5", "governor-preflight": "refuse" },
      { tokens: 500_000, contextWindow: 1_000_000, percent: 50 },
      { model: UNPRICED_MODEL },
    );
    piGovernor(harness.pi);
    harness.sessionEntries.push(expensiveUsage(0));

    await harness.dispatch("session_start");
    assert.deepEqual(await harness.dispatch("input", { text: "go", source: "interactive" }), [
      { action: "continue" },
    ]);

    await harness.dispatch("session_shutdown");
  });
});

describe("interactive limit control", () => {
  const setLimit = async (harness: Harness, args: string) => {
    const governor = harness.commands.get("governor");
    assert.ok(governor, "/governor must be registered");
    await governor.handler(args, harness.ctx);
  };

  it("writes /governor max-cost to the project config file", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: true, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await setLimit(harness, "max-cost 5");

    const written = JSON.parse(readFileSync(join(cwd, ".pi", "governor.json"), "utf8")) as Record<string, any>;
    assert.equal(written.limits.costUsd, 5);
    // The limit takes effect immediately, without a reload.
    assert.match(harness.statuses.get("governor") ?? "", /\$0\.00\/\$5\.00/);

    await harness.dispatch("session_shutdown");
  });

  it("parses time units, percentages, and token suffixes", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: true, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await setLimit(harness, "max-time 2h");
    await setLimit(harness, "max-context 80%");
    await setLimit(harness, "max-tokens 2m");
    await setLimit(harness, "max-turns 40");

    const written = JSON.parse(readFileSync(join(cwd, ".pi", "governor.json"), "utf8")) as Record<string, any>;
    assert.equal(written.limits.timeMinutes, 120);
    assert.equal(written.limits.contextPercent, 80);
    assert.equal(written.limits.totalTokens, 2_000_000);
    assert.equal(written.limits.turns, 40);

    await harness.dispatch("session_shutdown");
  });

  it("clears a single limit with off-<name> and keeps the others", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: true, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await setLimit(harness, "max-cost 5");
    await setLimit(harness, "max-turns 40");
    await setLimit(harness, "off-cost");

    const written = JSON.parse(readFileSync(join(cwd, ".pi", "governor.json"), "utf8")) as Record<string, any>;
    assert.equal(written.limits.costUsd, null);
    assert.equal(written.limits.turns, 40);

    await harness.dispatch("session_shutdown");
  });

  it("rejects a nonsensical value without writing", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: true, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await setLimit(harness, "max-cost expensive");
    assert.ok(harness.notifications.some((line) => /could not read "expensive"/.test(line)));

    // Nothing should have been persisted at all.
    assert.equal(existsSync(join(cwd, ".pi", "governor.json")), false);

    await harness.dispatch("session_shutdown");
  });

  it("reports session-only changes when the project is untrusted", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: false, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await setLimit(harness, "max-cost 5");

    assert.ok(harness.notifications.some((line) => /session only/.test(line)), harness.notifications.join("\n"));
    // The change still applies to this session.
    assert.match(harness.statuses.get("governor") ?? "", /\$0\.00\/\$5\.00/);

    await harness.dispatch("session_shutdown");
  });

  it("falls back to a printed report outside TUI mode", async () => {
    const cwd = tempProject();
    const harness = createHarness({ "governor-max-cost": "5" }, undefined, { cwd, trusted: true, model: PRICED_MODEL });
    (harness.ctx as unknown as { mode: string }).mode = "print";
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await setLimit(harness, "");

    assert.ok(harness.notifications.some((line) => /pi-governor ·/.test(line)), harness.notifications.join("\n"));

    await harness.dispatch("session_shutdown");
  });
});

describe("turn accounting (off-by-one found by running a real session)", () => {
  /**
   * A turn's assistant message lands *before* its tool calls run, so a naive
   * "count assistant messages" turn counter reports the in-flight turn as
   * complete and blocks the first turn's own tools. Observed in a real session:
   * `--governor-max-turns 1` blocked the very first `bash` call.
   */
  const newHarness = async () => {
    const harness = createHarness({ "governor-max-turns": "1" });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");
    return harness;
  };

  it("does not count the in-flight turn as complete", async () => {
    const harness = await newHarness();

    // Turn 1: assistant message has landed, its tools are starting.
    harness.sessionEntries.push(assistantEntry({ toolCalls: 1 }));
    await harness.dispatch("turn_start");

    const results = await harness.dispatch("tool_call", { toolName: "bash", input: {} });
    assert.deepEqual(results, [undefined], "turn 1's own tools must be allowed");

    await harness.dispatch("session_shutdown");
  });

  it("blocks the next turn's tools once that turn is complete", async () => {
    const harness = await newHarness();

    harness.sessionEntries.push(assistantEntry({ toolCalls: 1 }));
    await harness.dispatch("turn_start");
    await harness.dispatch("tool_call", { toolName: "bash", input: {} });
    await harness.dispatch("turn_end", { turnIndex: 0, toolResults: [] });

    // Turn 2 begins: a second assistant message lands.
    harness.sessionEntries.push(assistantEntry({ toolCalls: 1 }));
    await harness.dispatch("turn_start");

    const results = await harness.dispatch("tool_call", { toolName: "bash", input: {} });
    const blocked = results[0] as { block: boolean; reason: string } | undefined;
    assert.equal(blocked?.block, true, "turn 2's tools must be blocked");
    assert.match(blocked?.reason ?? "", /turn count budget exceeded/);

    await harness.dispatch("session_shutdown");
  });

  it("still blocks on the first tool call for non-turn limits", async () => {
    // Cost is not turn-scoped, so it must block immediately.
    const harness = createHarness({ "governor-max-cost": "0.01" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 0.5, toolCalls: 1 }));
    await harness.dispatch("session_start");
    await harness.dispatch("turn_start");

    const results = await harness.dispatch("tool_call", { toolName: "bash", input: {} });
    assert.equal((results[0] as { block: boolean } | undefined)?.block, true);

    await harness.dispatch("session_shutdown");
  });

  it("reports both responses of a turn-and-wrap-up run", async () => {
    // maxTurns 1 leaves the model one tool-free turn to explain itself, so a
    // real run ends with two assistant messages against a limit of one.
    const harness = await newHarness();
    harness.sessionEntries.push(assistantEntry({ toolCalls: 1 }));
    await harness.dispatch("turn_start");
    await harness.dispatch("turn_end", { turnIndex: 0, toolResults: [] });
    harness.sessionEntries.push(assistantEntry({ toolCalls: 0 }));
    await harness.dispatch("turn_end", { turnIndex: 1, toolResults: [] });

    // Over budget, but the block still happens on later tool calls.
    assert.match(harness.statuses.get("governor") ?? "", /\/1t/);

    await harness.dispatch("session_shutdown");
  });
});

describe("commands", () => {
  const run = async (harness: Harness, args: string) => {
    const governor = harness.commands.get("governor");
    assert.ok(governor, "/governor must be registered");
    await governor.handler(args, harness.ctx);
  };

  it("reset restarts the session clock and clears warnings", async () => {
    const harness = createHarness({ "governor-max-cost": "5" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 4.5 }));
    await harness.dispatch("session_start");
    await harness.dispatch("turn_end", { turnIndex: 0, toolResults: [] });
    assert.ok(harness.notifications.some((line) => /at 90% of budget/.test(line)), "warned first");

    await run(harness, "reset");

    // Clock restarted and the warn latch cleared, so it can fire again.
    assert.match(harness.statuses.get("governor") ?? "", /0s/);
    const before = harness.notifications.length;
    await harness.dispatch("turn_end", { turnIndex: 1, toolResults: [] });
    assert.ok(harness.notifications.length > before, "warning re-armed after reset");

    await harness.dispatch("session_shutdown");
  });

  it("reload picks up an edited project config", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: true, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await run(harness, "max-cost 5");
    await harness.dispatch("session_start");
    assert.match(harness.statuses.get("governor") ?? "", /\$0\.00\/\$5\.00/);

    // Change the file underneath the session, as a manual edit would.
    const path = join(cwd, ".pi", "governor.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    parsed.limits.costUsd = 42;
    writeFileSync(path, JSON.stringify(parsed), "utf8");

    await run(harness, "reload");
    assert.match(harness.statuses.get("governor") ?? "", /\$0\.00\/\$42\.00/);
    assert.ok(harness.notifications.some((line) => /loaded .*governor\.json/.test(line)));

    await harness.dispatch("session_shutdown");
  });

  it("help lists the available subcommands", async () => {
    const harness = createHarness();
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await run(harness, "help");
    const help = harness.notifications.find((line) => /max-cost/.test(line));
    assert.ok(help, harness.notifications.join("\n"));
    assert.match(help, /\/governor reset/);
    assert.match(help, /pause\|resume/);

    await harness.dispatch("session_shutdown");
  });

  it("completes subcommands and returns null when nothing matches", async () => {
    const harness = createHarness();
    piGovernor(harness.pi);
    const command = harness.commands.get("governor") as unknown as {
      getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
    };
    assert.ok(command.getArgumentCompletions);

    const maxed = command.getArgumentCompletions("max-");
    assert.deepEqual(
      maxed?.map((item) => item.value).sort(),
      ["max-context", "max-cost", "max-time", "max-tokens", "max-turns"],
    );
    assert.deepEqual(command.getArgumentCompletions("off-")?.map((i) => i.value).sort(), [
      "off-context",
      "off-cost",
      "off-time",
      "off-tokens",
      "off-turns",
    ]);
    assert.equal(command.getArgumentCompletions("zzz"), null);
  });

  it("opens the report overlay in TUI mode and closes on escape", async () => {
    const harness = createHarness({ "governor-max-cost": "5" }, undefined, { model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    await run(harness, "report");

    const component = harness.component;
    assert.ok(component, "report overlay was not created");
    const lines = component.render(80);
    const text = lines.join("\n");
    assert.match(text, /pi-governor ·/);
    assert.match(text, /session cost/);
    assert.match(text, /forecast/);
    assert.ok(
      lines.every((line) => visibleWidth(line) <= 80),
      "report overlay exceeded the render width",
    );

    component.handleInput("\x1b"); // escape
    assert.equal(harness.componentClosed, true);

    await harness.dispatch("session_shutdown");
  });
});

describe("compaction and model events", () => {
  it("survives session_compact and re-arms the crossing", async () => {
    const harness = createHarness({ "governor-max-context": "40" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry());
    await harness.dispatch("session_start");

    await harness.dispatch("session_compact", { reason: "manual" });
    assert.ok(harness.statuses.get("governor"));

    await harness.dispatch("session_shutdown");
  });

  it("survives a failed compaction", async () => {
    const harness = createHarness({ "governor-max-context": "40" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry());
    await harness.dispatch("session_start");

    await harness.dispatch("session_compact_failed", { reason: "threshold", errorMessage: "boom" });
    assert.ok(harness.statuses.get("governor"));

    await harness.dispatch("session_shutdown");
  });

  it("refreshes the status on a thinking level change", async () => {
    const harness = createHarness({ "governor-max-cost": "5" });
    piGovernor(harness.pi);
    harness.sessionEntries.push(assistantEntry({ cost: 1 }));
    await harness.dispatch("session_start");

    await harness.dispatch("thinking_level_select", { level: "high" });
    assert.match(harness.statuses.get("governor") ?? "", /\$1\.00/);

    await harness.dispatch("session_shutdown");
  });

  it("reports configuration problems on session start", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, {
      cwd,
      projectConfig: { limits: { costUsd: "cheap" } },
      model: PRICED_MODEL,
    });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    const diagnostic = harness.notifications.find((line) => /configuration problems/.test(line));
    assert.ok(diagnostic, harness.notifications.join("\n"));
    assert.match(diagnostic, /limits\.costUsd must be a number or null/);

    await harness.dispatch("session_shutdown");
  });
});

describe("panel integration and active-time accounting", () => {
  it("opens the settings panel from a bare /governor in TUI mode", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: true, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    const governor = harness.commands.get("governor");
    assert.ok(governor);
    await governor.handler("", harness.ctx);

    const component = harness.component;
    assert.ok(component, "panel was not opened");
    const text = component.render(80).join("\n");
    assert.match(text, /pi-governor/);
    assert.match(text, /Cost limit/);
    // Trusted project: the panel points at the project config path. The path
    // wraps across lines at width 80, so match its end rather than the whole.
    assert.match(text, /saving to/);
    assert.match(text, /governor\.json/);

    await harness.dispatch("session_shutdown");
  });

  it("marks the target as session-only when the project is untrusted", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, { cwd, trusted: false, model: PRICED_MODEL });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    const governor = harness.commands.get("governor");
    assert.ok(governor);
    await governor.handler("", harness.ctx);

    assert.match(harness.component?.render(80).join("\n") ?? "", /untrusted — session only/);

    await harness.dispatch("session_shutdown");
  });

  it("does not open the panel outside TUI mode", async () => {
    const harness = createHarness({ "governor-max-cost": "5" }, undefined, { model: PRICED_MODEL });
    (harness.ctx as unknown as { mode: string }).mode = "rpc";
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    const governor = harness.commands.get("governor");
    assert.ok(governor);
    await governor.handler("", harness.ctx);

    // Falls back to the printed report instead of a component.
    assert.equal(harness.component, null);
    assert.ok(harness.notifications.some((line) => /pi-governor ·/.test(line)));

    await harness.dispatch("session_shutdown");
  });

  it("accumulates active time only while an agent run is in flight", async () => {
    const cwd = tempProject();
    const harness = createHarness({}, undefined, {
      cwd,
      projectConfig: { timeMode: "active" },
      model: PRICED_MODEL,
    });
    piGovernor(harness.pi);
    await harness.dispatch("session_start");

    // Idle time must not count.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await harness.dispatch("agent_start");
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await harness.dispatch("agent_settled");

    const governor = harness.commands.get("governor");
    assert.ok(governor);
    await governor.handler("report", harness.ctx);

    const report = harness.component?.render(100).join("\n") ?? "";
    const elapsed = /elapsed\s+(\S+) wall · (\S+) active/.exec(report);
    assert.ok(elapsed, report);
    const active = elapsed[2] ?? "";
    // Only ~1.1s was spent inside an agent run, so active time must be ~1s
    // while wall time (the harness header is 60s old) is far larger.
    assert.equal(active, "1s", `active time should cover only the agent run, got ${active}`);

    await harness.dispatch("session_shutdown");
  });
});
