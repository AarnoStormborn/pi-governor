/**
 * Rendering and interaction tests for the governor panel.
 *
 * These drive the real component tree (`SettingsList`, `Input`, `Container`)
 * with a stub TUI, so layout, key handling, and config mapping are exercised
 * without a terminal. Two real bugs were found this way:
 *
 *   1. `getSettingsListTheme()` threw "Theme not initialized" because it reads
 *      a module-global; the panel now derives its theme from the live theme.
 *   2. Prefilling the numeric input parked the cursor at column 0, so typing
 *      appended around the old value. The field is now empty with the current
 *      value shown as a placeholder.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, mergeConfig, type GovernorConfigPatch } from "../src/config.ts";
import { openGovernorPanel } from "../src/panel.ts";
import type { GovernorConfig } from "../src/types.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

interface Harness {
  component: {
    render(width: number): string[];
    handleInput(data: string): void;
    invalidate(): void;
  };
  patches: GovernorConfigPatch[];
  /** Value passed to `done()`, or the sentinel while the panel is open. */
  closedWith: unknown;
  render(width?: number): string[];
  type(text: string): void;
  selectedRow(): string;
  findRow(matcher: RegExp): string | undefined;
}

const OPEN = Symbol("panel-still-open");

async function openPanel(config: GovernorConfig, targetPath = "/proj/.pi/governor.json"): Promise<Harness> {
  const patches: GovernorConfigPatch[] = [];
  let closedWith: unknown = OPEN;
  let component: Harness["component"] | null = null;

  // Deliberately minimal: no global theme, no keybinding manager, no real TUI.
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const tui = { requestRender: () => {} };

  const ctx = {
    mode: "tui",
    hasUI: true,
    ui: {
      theme,
      custom: (factory: (t: unknown, th: unknown, kb: unknown, done: (v: unknown) => void) => unknown) => {
        component = factory(tui, theme, {}, (value: unknown) => {
          closedWith = value;
        }) as Harness["component"];
        return Promise.resolve(undefined);
      },
    },
  };

  await openGovernorPanel(ctx as never, {
    config,
    targetPath,
    onChange: (patch) => patches.push(patch),
  });

  assert.ok(component, "panel component was not created");
  const created = component as Harness["component"];

  const render = (width = 80) => created.render(width);
  return {
    component: created,
    patches,
    get closedWith() {
      return closedWith;
    },
    render,
    type: (text: string) => {
      for (const character of text) created.handleInput(character);
    },
    selectedRow: () => render().find((line) => line.startsWith("→"))?.replace("→", "").trim() ?? "",
    findRow: (matcher: RegExp) => render().find((line) => matcher.test(line)),
  } as Harness;
}

const budgeted = () =>
  mergeConfig(DEFAULT_CONFIG, {
    limits: { costUsd: 5, timeMinutes: 90 },
    status: { segments: ["cost", "context", "time", "turns"] },
  });

describe("panel rendering", () => {
  it("renders without a globally initialised theme", async () => {
    // Regression: getSettingsListTheme() throws "Theme not initialized" when
    // the module-global theme has not been set up.
    const harness = await openPanel(budgeted());
    assert.ok(harness.render().length > 0);
  });

  it("shows the title and the file it writes to", async () => {
    const harness = await openPanel(budgeted(), "/proj/.pi/governor.json");
    const text = harness.render().join("\n");
    assert.match(text, /pi-governor/);
    assert.match(text, /saving to \/proj\/\.pi\/governor\.json/);
  });

  it("lists every limit and enforcement row with its current value", async () => {
    const harness = await openPanel(budgeted());
    const text = harness.render().join("\n");

    for (const label of [
      "Cost limit",
      "Time limit",
      "Context limit",
      "Token limit",
      "Turn limit",
      "Enforcement",
      "When over budget: tools",
      "When over budget: prompts",
      "When over budget: turns",
      "When over budget: context",
      "Forecast overspend",
      "Forecast next turn",
      "Status line",
      "Status metrics",
    ]) {
      assert.match(text, new RegExp(label), `missing row: ${label}`);
    }

    assert.match(text, /Cost limit\s+\$5\.00/);
    assert.match(text, /Time limit\s+90m/);
    assert.match(text, /Context limit\s+off/);
  });

  it("never exceeds the requested render width", async () => {
    const harness = await openPanel(budgeted());
    for (const width of [30, 40, 60, 80, 120, 200]) {
      const overwide = harness.render(width).filter((line) => visibleWidth(line) > width);
      assert.deepEqual(overwide, [], `line(s) exceeded width ${width}`);
    }
  });

  it("describes the selected row", async () => {
    const harness = await openPanel(budgeted());
    assert.match(harness.render().join("\n"), /Refuse or block once session cost reaches this amount/);
  });
});

describe("panel numeric entry", () => {
  it("accepts a freshly typed value", async () => {
    const harness = await openPanel(budgeted());
    harness.component.handleInput(ENTER); // open Cost limit
    harness.type("12.5");
    harness.component.handleInput(ENTER);

    assert.deepEqual(harness.patches, [{ limits: { costUsd: 12.5 } }]);
    assert.match(harness.findRow(/Cost limit/) ?? "", /\$12\.50/);
  });

  it("does not prefill the field, so typing replaces rather than appends", async () => {
    // Regression: a prefilled value left the cursor at column 0, so "12.5"
    // entered over "5" produced "12.55".
    const harness = await openPanel(budgeted());
    harness.component.handleInput(ENTER);
    harness.type("7");
    harness.component.handleInput(ENTER);

    assert.deepEqual(harness.patches, [{ limits: { costUsd: 7 } }]);
  });

  it("rejects invalid input with an explanation and keeps the submenu open", async () => {
    const harness = await openPanel(budgeted());
    harness.component.handleInput(ENTER);
    harness.type("abc");
    harness.component.handleInput(ENTER);

    assert.deepEqual(harness.patches, [], "invalid input must not patch");
    const text = harness.render().join("\n");
    assert.match(text, /Could not read "abc"/);
    // Still in the submenu, not back at the list.
    assert.match(text, /Cost limit:/);
  });

  it("keeps the current value when submitted blank", async () => {
    const harness = await openPanel(budgeted());
    harness.component.handleInput(ENTER);
    harness.component.handleInput(ENTER);

    assert.deepEqual(harness.patches, []);
    assert.match(harness.findRow(/Cost limit/) ?? "", /\$5\.00/);
  });

  it("clears a limit when given \"off\"", async () => {
    const harness = await openPanel(budgeted());
    harness.component.handleInput(ENTER);
    harness.type("off");
    harness.component.handleInput(ENTER);

    assert.deepEqual(harness.patches, [{ limits: { costUsd: null } }]);
    assert.match(harness.findRow(/Cost limit/) ?? "", /off/);
  });

  it("parses time units, percentages, and token suffixes", async () => {
    const rows: Array<[number, string, GovernorConfigPatch]> = [
      [1, "2h", { limits: { timeMinutes: 120 } }],
      [2, "80%", { limits: { contextPercent: 80 } }],
      [3, "2m", { limits: { totalTokens: 2_000_000 } }],
      [4, "40", { limits: { turns: 40 } }],
    ];

    for (const [rowIndex, input, expected] of rows) {
      const harness = await openPanel(DEFAULT_CONFIG);
      for (let i = 0; i < rowIndex; i++) harness.component.handleInput(DOWN);
      harness.component.handleInput(ENTER);
      harness.type(input);
      harness.component.handleInput(ENTER);
      assert.deepEqual(harness.patches, [expected], `row ${rowIndex} with "${input}"`);
    }
  });

  it("rejects an out-of-range percentage", async () => {
    const harness = await openPanel(DEFAULT_CONFIG);
    harness.component.handleInput(DOWN);
    harness.component.handleInput(DOWN); // Context limit
    harness.component.handleInput(ENTER);
    harness.type("150");
    harness.component.handleInput(ENTER);

    assert.deepEqual(harness.patches, []);
    assert.match(harness.render().join("\n"), /Could not read "150"/);
  });
});

describe("panel toggles", () => {
  it("cycles every enforcement and status row to a valid patch", async () => {
    const harness = await openPanel(DEFAULT_CONFIG);
    const expected: Record<string, GovernorConfigPatch> = {
      "Time limit counts": { timeMode: "active" },
      "Enforcement": { enforcement: { enabled: false } },
      "When over budget: tools": { enforcement: { onToolCall: "allow" } },
      "When over budget: prompts": { enforcement: { onPrompt: "allow" } },
      "When over budget: turns": { enforcement: { onTurn: "abort" } },
      "When over budget: context": { enforcement: { onContext: "observe" } },
      "Forecast overspend": { enforcement: { onPreflight: "refuse" } },
      "Forecast next turn": { preflight: { enabled: false } },
      "Forecast output tokens": { preflight: { assumedOutputTokens: 2000 } },
      "Forecast uses cache rate": { preflight: { useCacheEstimate: false } },
      "Status line": { status: { enabled: false } },
    };

    const seen = new Set<string>();
    for (let row = 0; row < 18; row++) {
      const label = harness.selectedRow().replace(/\s{2,}.*$/, "").trim();
      const before = harness.patches.length;
      harness.component.handleInput(ENTER);

      // Numeric rows open a text submenu; close it without submitting so the
      // cursor stays on this row and the outer loop keeps its place.
      if (/currently /.test(harness.render().join("\n"))) {
        harness.component.handleInput(ESC);
        assert.equal(harness.patches.length, before, `row ${row} (${label}) patched from a submenu`);
      } else if (expected[label]) {
        seen.add(label);
        assert.equal(harness.patches.length, before + 1, `row ${row} (${label}) produced no patch`);
        assert.deepEqual(harness.patches[harness.patches.length - 1], expected[label], `row ${row} (${label})`);
      }

      harness.component.handleInput(DOWN);
    }

    // Every toggle row must have been reached and verified.
    assert.deepEqual([...seen].sort(), Object.keys(expected).sort());
  });

  it("cycles the warn ratio as a fraction", async () => {
    const harness = await openPanel(DEFAULT_CONFIG);
    // Row 6 is "Warn at"; rows 0-4 are numeric and 5 is the time mode.
    for (let i = 0; i < 6; i++) harness.component.handleInput(DOWN);
    assert.match(harness.selectedRow(), /Warn at/);
    harness.component.handleInput(ENTER);
    assert.deepEqual(harness.patches, [{ warnRatio: 0.9 }]);
  });
});

describe("panel dismissal", () => {
  it("closes from the top level", async () => {
    const harness = await openPanel(budgeted());
    harness.component.handleInput(ESC);
    assert.equal(harness.closedWith, undefined);
  });

  it("closes a submenu without closing the panel", async () => {
    const harness = await openPanel(budgeted());
    harness.component.handleInput(ENTER); // enter Cost limit submenu
    assert.match(harness.render().join("\n"), /Cost limit:/);

    harness.component.handleInput(ESC);
    // Back at the list, panel still open.
    assert.notEqual(harness.closedWith, undefined as never);
    assert.equal(harness.closedWith, OPEN);
    assert.match(harness.render().join("\n"), /pi-governor/);
  });

  it("navigates in both directions", async () => {
    const harness = await openPanel(budgeted());
    harness.component.handleInput(DOWN);
    assert.match(harness.selectedRow(), /Time limit/);
    harness.component.handleInput(DOWN);
    assert.match(harness.selectedRow(), /Context limit/);
    harness.component.handleInput(UP);
    assert.match(harness.selectedRow(), /Time limit/);
  });
});
