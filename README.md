# pi-governor

**Budget governance for the [pi coding agent](https://pi.dev).** Cap session time, cost, context usage, tokens, and turns — then actually *enforce* those caps.

Most pi budget tooling reports. `pi-governor` governs: when a budget is blown it blocks tool calls, refuses new prompts, aborts the running agent, and compacts context. The model keeps working until it runs out of rope, and then it stops.

```
⚖ $1.24/$5.00 · ctx 34%/85% · 12m/1h30m · 8/50t
```

---

## Why

An agent in a loop is an unbounded spend. Existing extensions (`pi-powerline-footer`, `@narumitw/pi-usage`, `@quintinshaw/pi-dynamic-workflows`) show you the number going up; a footer does not stop it. `pi-governor` closes the loop:

| | Display-only extensions | `pi-governor` |
|---|---|---|
| Cost / tokens / context | shown | shown **and** enforced |
| Wall-clock time | shown | shown **and** enforced |
| Over budget | keeps going | blocks tool calls, refuses prompts, aborts, compacts |

## Install

```bash
pi install npm:pi-governor
```

Try it without installing:

```bash
pi -e npm:pi-governor
```

## Quick start

Open the panel and set a limit — no file editing required:

```
/governor
```

```
pi-governor                      ← pi-governor
↑↓ move · Enter change · Esc close
saving to /your/project/.pi/governor.json

  Cost limit                $5.00
  Time limit                1h30m
  Context limit             off
  Token limit               off
  Turn limit                off
  Time limit counts         wall
  Warn at                   80%
  Enforcement               on
  When over budget: tools   block
  When over budget: prompts refuse
  When over budget: turns   abort
  When over budget: context compact
  Forecast overspend        warn
  Forecast next turn        on
  Forecast output tokens    8000
  Forecast uses cache rate  on
  Status line               on
  Status metrics            cost,context,time,turns
```

Every row applies immediately. Changes are written to `.pi/governor.json` in the current project, so they are committable and shareable with your team.

Prefer the keyboard? Every limit has a quick command:

```
/governor max-cost 5          /governor cost 5
/governor max-time 90m        /governor time 2h
/governor max-context 80%     /governor context 80
/governor max-tokens 2m       /governor tokens 2000000
/governor max-turns 40        /governor turns 40
/governor off-cost            (or off-time, off-context, ...)
```

`/governor time 2h`, `/governor tokens 2m` and `/governor context 80%` all work — units are parsed. If the project is not trusted, changes still apply but `/governor` tells you they are session-only rather than silently saving somewhere that will not load.

Or skip the governor entirely and use CLI flags:

```bash
pi --governor-max-cost 2 --governor-max-turns 30 "refactor the auth module"
```

Nothing is enforced until you configure at least one limit — with no config the status line reads `⚖ unconfigured` and the governor stays out of the way.

## What it measures

Every total is derived from the **session entry list**, not from in-memory counters. That means numbers survive `/reload`, resume, `/fork`, `/clone`, and compaction, and they match pi's own accounting: entries that were billed are counted, including abandoned branches and compaction summaries.

| Limit | Source |
|---|---|
| `time` | Session header timestamp (or `/governor reset`) → wall clock, or time spent in agent runs with `timeMode: "active"` |
| `cost` | `usage.cost.total` summed over assistant messages, tool-result usage, compaction and branch summaries |
| `context` | `ctx.getContextUsage()` — percent of the active model's context window |
| `tokens` | `usage.totalTokens` over the same entries |
| `turns` | Assistant responses that completed normally (errored and aborted responses are not counted) |
| tool calls | `toolCall` content blocks; displayed but **not** a v1 limit |

## Enforcement model

Warn first, enforce second. `warnRatio` (default `0.8`) controls the warning threshold; `1.0` is always the enforcement point.

When any configured limit is **exceeded** and enforcement is on:

| Trigger | Action | Config key |
|---|---|---|
| The model tries to call a tool | Block it, and hand the reason back as the tool result | `enforcement.onToolCall: "block"` |
| You submit a new prompt | Refuse it without starting a turn | `enforcement.onPrompt: "refuse"` |
| Context crosses its limit | Compact once, preserving decisions and open tasks | `enforcement.onContext: "compact"` |
| The *next* turn is forecast to cross the **cost** limit | Warn, or refuse before the money is spent | `enforcement.onPreflight: "warn" \| "refuse"` |
| A turn finishes while over budget | Abort the run. **Off by default** | `enforcement.onTurn: "abort"` |

Each action can be turned off individually (`"allow"` / `"observe"`), or all at once with `enforcement.enabled: false`, `--governor-observe`, or `/governor pause`.

### Why blocking is graceful, and `abort` is not

Blocking a tool call returns the reason to the model as an ordinary tool result, so the model can finish its thought and explain what happened. In a real run with `--governor-max-turns 1`:

> I have to stop here — the pi-governor turn budget was exceeded after the first command.
>
> 1. `echo one` → **one** ✅
> 2. `echo two` → ❌ blocked by pi-governor (turn count budget exceeded)
> 3. `echo three` → not attempted
>
> If you'd like, restart or raise the governor budget and I can run the remaining two commands.

Because blocking already forces a tool-free wrap-up turn, `onTurn` defaults to `allow`. `abort` is a harder stop that ends the run immediately — it budgets nothing extra, but it also throws away the model's explanation. Enable it for money or time ceilings where even one wrap-up turn is unwanted spend.

A limit of N therefore allows **N tool-using turns, then one tool-free turn to wrap up.**

**You are never locked out.** Extension commands are dispatched before the `input` event, so `/governor` always works — even when prompts are being refused. Use it to raise a limit, reset the clock, or pause.

## Forecasting the next turn

Pi computes cost **locally** from token counts × a rate table, and it does so at **stream end**. A cost limit is therefore a lagging indicator: it can only react after a turn has been paid for, and it overshoots by up to one full turn.

That overshoot is not small. At a 500k-token context with a 65.5k output ceiling:

| Model | Prompt | Output | One turn |
|---|---|---|---|
| deepseek-v4-flash | $0.11 | $0.04 | **$0.15** |
| claude-sonnet | $1.50 | $0.98 | **$2.48** |
| claude-opus | $7.50 | $4.92 | **$12.42** |

A `$5` limit on Opus can spend ~$12.40 before it trips. Pre-flight fixes that by pricing the next turn *before* it is spent:

- The governor knows the exact context size (`ctx.getContextUsage()`) and the model's rates (`ctx.model.cost`).
- With `useCacheEstimate` it credits the **observed cache hit rate**; otherwise it assumes a cold cache, which is the conservative worst case.
- When the projected total would cross the cost limit: `onPreflight: "warn"` reports it and the status line shows `→$6.40`; `onPreflight: "refuse"` stops the turn before it is paid for.

Caching matters more than volume here. Measured on a real session: `cacheRead` was **31× cheaper** than `input`, 97.9% of input tokens were cache reads, and the same work would have cost **12.9× more** uncached. The forecast shows which basis it used.

```
forecast  next turn ~$0.0073 using observed 98% cache hit rate
forecast  projected total $0.2376 of $3.00 · output assumption 8000 tokens
```

## Unpriced models

Pi computes cost as `tokens × rates`, and providers that build catalogs from a hardcoded table plus a fallback (`MODEL_COSTS[id] ?? ZERO_MODEL_COST`) hand out **all-zero rates** for every model they have not priced yet.

On such a model `usage.cost.total` is permanently `$0.00`, so a `costUsd` limit **never fires**. It fails silently: the footer reads a reassuring `⚖ $0.00/$5.00` no matter how much you spend.

The governor detects this and says so on `session_start`, and again whenever you switch models:

```
⚖ cost limit cannot fire: commandcode/brand-new-model has no pricing data
  (all rates are 0), so spend is reported as $0.00.
  Set a limit on time, context, tokens, or turns instead, or price the model in models.json.
```

If you use a cost limit, prefer a provider whose models are priced, or add rates under `cost` in `models.json`. Pre-flight safely degrades to no-forecast (it never blocks) when pricing is unavailable.

## Configuration

Resolved in order, later wins:

1. built-in defaults
2. `~/.pi/agent/governor.json`
3. `<cwd>/.pi/governor.json` — **only when the project is trusted**
4. `--governor-*` CLI flags

Unknown keys and malformed values are reported and skipped; a broken config can never crash a session.

```json
{
  "enabled": true,
  "warnRatio": 0.8,
  "timeMode": "wall",
  "exposeTool": false,

  "limits": {
    "timeMinutes": 90,
    "costUsd": 5,
    "contextPercent": 85,
    "totalTokens": 2000000,
    "turns": 50
  },

  "enforcement": {
    "enabled": true,
    "onToolCall": "block",
    "onPrompt": "refuse",
    "onTurn": "allow",
    "onContext": "compact",
    "onPreflight": "warn"
  },

  "preflight": {
    "enabled": true,
    "assumedOutputTokens": 8000,
    "useCacheEstimate": true
  },

  "status": {
    "enabled": true,
    "segments": ["cost", "context", "time", "turns"],
    "updateIntervalMs": 1000
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch; `false` makes the extension inert |
| `warnRatio` | number 0.05–1 | `0.8` | Fraction of a limit at which warnings start |
| `timeMode` | `"wall"` \| `"active"` | `"wall"` | Whether `time` counts wall clock or agent-active time |
| `exposeTool` | boolean | `false` | Register a `governor_status` tool the model can call |
| `limits.*` | number \| null | `null` | Any limit set to `null` (or omitted) is not enforced |
| `enforcement.enabled` | boolean | `true` | Act on exceeded limits instead of only reporting |
| `enforcement.onToolCall` | `"block"` \| `"allow"` | `"block"` | Block tool calls when over budget |
| `enforcement.onPrompt` | `"refuse"` \| `"allow"` | `"refuse"` | Refuse new prompts when over budget |
| `enforcement.onTurn` | `"abort"` \| `"allow"` | `"allow"` | Abort the run at the end of a turn when over budget. Off by default — see below |
| `enforcement.onContext` | `"compact"` \| `"observe"` | `"compact"` | Compact when the context limit is crossed |
| `enforcement.onPreflight` | `"warn"` \| `"refuse"` | `"warn"` | React before a turn forecast to cross the cost limit |
| `preflight.enabled` | boolean | `true` | Price the next turn before it is spent |
| `preflight.assumedOutputTokens` | number | `8000` | Output tokens to assume when forecasting |
| `preflight.useCacheEstimate` | boolean | `true` | Credit the observed cache hit rate; off assumes a cold cache |
| `status.enabled` | boolean | `true` | Show the footer status line |
| `status.segments` | array | `["cost","context","time","turns"]` | Which metrics to render and in what order. Also accepts `tokens`, `toolCalls` |
| `status.updateIntervalMs` | number 250–60000 | `1000` | Status refresh interval |

An example file is included: [`governor.example.json`](./governor.example.json). A JSON Schema for editor validation ships as [`governor.schema.json`](./governor.schema.json) — point `$schema` at it (or copy it next to your config) for completion and inline docs.

## CLI flags

```bash
pi --governor-max-cost 5 --governor-max-time 90 --governor-max-context 85
pi --governor-max-tokens 2000000 --governor-max-turns 50
pi --governor-observe          # measure and report, never enforce
pi --governor-preflight refuse # stop before a turn forecast to overspend
pi --governor-tool             # let the model query its own budget
pi --governor-off              # disable completely for this run
```

Flags override the config files for that run only.

## Commands

| Command | Effect |
|---|---|
| `/governor` | Open the interactive limit panel (TUI), or print the report elsewhere |
| `/governor report` | Print the report instead of opening the panel |
| `/governor max-cost 5` | Set a limit: `cost`, `time`, `context`, `tokens`, `turns` (`max-` optional) |
| `/governor time 2h` | Units are parsed: `90m`, `2h`, `80%`, `2m` tokens |
| `/governor off-cost` | Clear one limit |
| `/governor reset` | Restart the session clock and clear warnings |
| `/governor pause` | Keep measuring, stop enforcing |
| `/governor resume` | Re-enable enforcement |
| `/governor reload` | Re-read `governor.json` files and flags |
| `/governor help` | Usage summary |

Pause state and the reset clock are persisted as a session entry, so they survive `/reload` and resume. `paused` shows a `⏸` marker in the status line.

## Recipes

**Cap an unattended overnight run**

```json
{ "limits": { "costUsd": 20, "timeMinutes": 480, "turns": 400 }, "enforcement": { "onToolCall": "block", "onPrompt": "refuse", "onTurn": "abort" } }
```

**Never overshoot a dollar budget** — forecast and stop before the spend:

```json
{ "limits": { "costUsd": 5 }, "enforcement": { "onPreflight": "refuse" }, "preflight": { "useCacheEstimate": false } }
```

`useCacheEstimate: false` prices the whole context at full input rate, so the forecast is deliberately pessimistic.

**Keep context small on a long refactor** — compact early, never hard-stop:

```json
{ "limits": { "contextPercent": 70 }, "enforcement": { "onContext": "compact", "onToolCall": "allow", "onPrompt": "allow", "onTurn": "allow" } }
```

**Team-wide project budget** — commit `.pi/governor.json`, and let individuals override with `--governor-max-cost`:

```json
{ "limits": { "costUsd": 3, "timeMinutes": 45 }, "status": { "segments": ["cost", "time"] } }
```

**Watch only, enforce later** — `--governor-observe` for a week, then read `/governor` to pick honest limits.

## Model-facing tool

With `"exposeTool": true` (or `--governor-tool`) the governor registers a `governor_status` tool so the model can check remaining budget before starting expensive work. It is off by default because every tool schema costs tokens in every request — which is a strange thing for a cost governor to do by default.

## How it works

- **Measurement** — `session_start`, `message_end`, `turn_end`, `tool_execution_start`, `agent_settled`, `model_select`, and compaction events trigger a refresh that re-aggregates session entries and re-evaluates limits.
- **Enforcement** — `tool_call` returns `{ block: true, terminate: true }`; `input` returns `{ action: "handled" }`; `turn_end` calls `ctx.abort()`; context crossings call `ctx.compact()` once per crossing, with a cooldown; pre-flight refusal is evaluated in the `input` handler before a turn starts.
- **Forecasting** — `estimateTurnCost()` prices the next turn from `ctx.getContextUsage()` × `ctx.model.cost`, using the observed cache hit rate when configured.
- **Persistence** — the panel and quick commands write to `.pi/governor.json` through `writeConfigFile()`, which merges into the **raw** JSON document so keys this version does not understand are preserved, then reloads from disk so in-memory state matches the file.
- **Status** — `ctx.ui.setStatus()` on a 1s unref'd timer, repainted only when the text actually changes. Cleared on `session_shutdown`.
- **Purity** — `config.ts`, `metrics.ts`, `limits.ts`, `status.ts`, `format.ts`, and `projection.ts` have no runtime dependency on pi and are covered by unit tests. `index.ts` is the wiring layer; `panel.ts` is the TUI layer.

## Development

```bash
npm install
npm test        # 145 unit, integration and panel-rendering tests, node:test + native TS
npm run check   # tsc --noEmit
npm run smoke   # load the extension in pi and exit
npm run pack:dry
```

Test the extension live without installing it:

```bash
pi -e . --governor-max-turns 3 --governor-observe
```

Then run `/governor` to open the panel and try a few limits.

## Publishing

```bash
npm version patch
npm publish
```

The package is discoverable on the [pi package gallery](https://pi.dev/packages) via the `pi-package` keyword. Pi bundles the core packages, so `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and `typebox` are declared as `peerDependencies` with `"*"` and never bundled.

## Security

Extensions run with your full system permissions. This one reads two JSON config files, writes to `.pi/governor.json` when you change a setting, makes no network requests, and spawns no processes. Read the source — it is under 1,400 lines across nine files.

## License

MIT
