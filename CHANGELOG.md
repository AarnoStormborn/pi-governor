# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `peerDependenciesMeta` marking the harness packages optional, so installing
  the package no longer pulls a duplicate copy of `pi-coding-agent`
  (170 packages down to 1).

### Changed

- Package `files` continues to exclude tests, and CI now fails if tests,
  `node_modules`, or a missing required file ends up in the tarball.

## [0.2.0]

Interactive control, and two correctness fixes behind the cost limit.

### Added

- `/governor` opens an interactive settings panel. Numeric limits open a text
  submenu (accepts `90`, `90m`, `2h`, `80%`, `2m`, or `off`); toggles cycle.
  Changes apply immediately and persist to `.pi/governor.json`.
- Quick commands: `/governor max-cost 5`, `time 2h`, `context 80%`, `tokens 2m`,
  `turns 40`, and `off-<limit>` to clear one.
- Limit changes are written by merging into the **raw** JSON document, so keys
  this version does not understand (and `$schema`) are preserved.
- Untrusted projects report changes as session-only instead of writing to a file
  that would never load.
- `governor.schema.json`, a JSON Schema for editor completion and validation.

### Fixed

- **Zero-cost models silently disabled the cost limit.** Pi computes cost as
  `tokens × rates` locally, and providers with a hardcoded pricing table plus a
  fallback hand out all-zero rates for any model they have not priced. A
  `costUsd` limit on such a model never fires while the footer reads `$0.00`.
  The governor now warns on `session_start` and on `model_select`.
- **Cost limits always overshot by up to one turn,** because cost is only
  computed at stream end. Pre-flight projection prices the next turn *before* it
  is spent, crediting the observed cache hit rate, and `onPreflight: "refuse"`
  stops a turn that would cross the limit. Measured overshoot on Opus at a 500k
  context was $12.42 against a $5 limit.
- Panel crashed on open: `getSettingsListTheme()` reads a module-global theme
  singleton and threw `Theme not initialized`. The panel now derives its theme
  from the live theme.
- Turn limits were off by one. A turn's assistant message lands *before* its
  tool calls run, so the in-flight turn was counted as complete and
  `--governor-max-turns 1` blocked the very first tool call.
- Blocking a tool call produced empty output, because `terminate: true` ended
  the run before the model could explain. The block is now an ordinary tool
  result so the model can report what happened.
- The panel's numeric field no longer prefills, which had parked the cursor at
  column 0 and appended new input around the old value.
- Invalid panel input keeps the submenu open with an explanation instead of
  closing and silently doing nothing.

### Changed

- `enforcement.onTurn` now defaults to `"allow"` rather than `"abort"`.
  Blocking tool calls already forces a tool-free wrap-up turn, so aborting only
  removed the model's explanation. `"abort"` remains available as a hard stop
  for money and time ceilings.

## [0.1.0]

Initial release.

### Added

- Budgets for session wall-clock or active time, cost in USD, context-window
  percentage, total tokens, and completed turns.
- Warn-then-enforce model: warnings at `warnRatio` (default 80%), enforcement at
  100%.
- Enforcement actions: block tool calls, refuse prompts, abort a turn, compact
  context on a crossing, and pre-flight refusal before an overspending turn.
- Footer status line via `ctx.ui.setStatus()`, plus a `/governor` report.
- Layered configuration: defaults, `~/.pi/agent/governor.json`,
  `<cwd>/.pi/governor.json`, then `--governor-*` flags.
- All totals derived from the session entry list, so they survive reload,
  resume, fork, and compaction, and match pi's own accounting.
- Optional `governor_status` tool (off by default) so the model can check its
  own budget.
