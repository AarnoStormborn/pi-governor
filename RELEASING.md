# Release checklist

Everything a release needs, in order. Commands assume the repo root.

---

## 1. Pre-release gate (automated — must be green)

- [ ] `npm ci` — clean install from the lockfile
- [ ] `npm run check` — `tsc --noEmit`, no type errors under `strict` +
      `noUncheckedIndexedAccess`
- [ ] `npm test` — full suite passes
- [ ] `npm run coverage` — review the table; no module below ~90% lines
- [ ] `git status --short` — working tree is clean, no scratch files
- [ ] No `TODO`, `FIXME`, `XXX`, or stray `console.log` in `src/`

```bash
npm ci && npm run check && npm test && npm run coverage
git status --short
grep -rnE "TODO|FIXME|XXX|console\.(log|debug)" src/ || echo "clean"
```

## 2. Package contents

- [ ] `npm pack --dry-run` shows only `src/`, `README.md`, `LICENSE`,
      `CHANGELOG.md`, `governor.example.json`, `governor.schema.json`,
      `package.json`
- [ ] `test/` and `node_modules/` are **absent** from the tarball
- [ ] `src/index.ts` (the `pi.extensions` entry) is present
- [ ] No `dependencies` — the harness packages are optional peers provided by pi

```bash
npm pack --dry-run
```

## 3. Install-path verification (the gate that catches real breakage)

Install the packed tarball into a throwaway project and confirm it loads with
**no peer dependencies present**:

```bash
npm pack
rm -rf /tmp/pkgverify && mkdir -p /tmp/pkgverify && cd /tmp/pkgverify
npm init -y >/dev/null && npm install /path/to/pi-governor-<version>.tgz
ls node_modules            # expect: pi-governor only
pi --no-extensions -e ./node_modules/pi-governor --help | grep governor-max-cost
```

- [ ] Only `pi-governor` was installed (an earlier build pulled 170 packages)
- [ ] All 9 `--governor-*` flags appear, proving the factory ran
- [ ] No load errors

## 4. Live testing (manual — cannot be automated)

The automated suite drives the extension through stubs. These paths need a real
terminal and a real model. Run them before tagging.

**Panel**

- [ ] `/governor` opens the panel and it renders legibly
- [ ] ↑↓ moves, Enter opens the numeric submenu on limit rows
- [ ] Typing `12.5` then Enter sets cost to `$12.50` (no prefill corruption)
- [ ] Typing `2h` on the time row sets `2h`
- [ ] Typing `abc` shows an error and leaves the submenu open
- [ ] Blank Enter keeps the current value
- [ ] Typing `off` clears the limit
- [ ] Escape in a submenu closes only the submenu; Escape again closes the panel
- [ ] Panel is usable at a narrow terminal width (~40 cols)

**Quick commands**

- [ ] `/governor max-cost 5` sets the limit and the footer updates immediately
- [ ] `.pi/governor.json` is created with the expected contents
- [ ] `cat .pi/governor.json` — existing keys and `$schema` survived the write
- [ ] `/governor off-cost` clears only the cost limit

**Status line**

- [ ] Footer shows `⚖ $0.00/$5.00 · ctx N% · 0s · 0/50t` on session start
- [ ] It updates during a turn and stays within the terminal width
- [ ] It clears on exit
- [ ] `/governor pause` shows the `⏸` marker

**Enforcement (each needs a real model run)**

- [ ] `--governor-max-turns 1` with a multi-tool prompt: first tool runs,
      second is blocked, and the model **explains** instead of going silent
- [ ] `--governor-observe` blocks nothing but still warns
- [ ] `--governor-off` leaves the footer empty and enforces nothing
- [ ] Over-budget prompts are refused, and `/governor` still works afterwards
      (the escape hatch)
- [ ] Context limit triggers a compaction that actually completes
- [ ] Pre-flight refusal stops a turn before it is spent (`onPreflight: refuse`)
- [ ] Unpriced model + cost limit produces the "cannot fire" warning
      (needs a model absent from the provider's pricing table)

**Persistence**

- [ ] Set a limit, restart pi, confirm it is still applied
- [ ] `/reload` keeps limits and re-registers the command
- [ ] `/resume` on an old session restores pause/reset state

## 5. Version and docs

- [ ] `package.json` `version` bumped (semver: breaking / feature / fix)
- [ ] `CHANGELOG.md` has an entry for the new version with the date
- [ ] `README.md` matches actual behaviour — check defaults, flags, commands
- [ ] `governor.example.json` and `governor.schema.json` agree with
      `DEFAULT_CONFIG` in `src/config.ts`
      (there is a test for this; keep it passing)

```bash
grep -n '"version"' package.json
```

## 6. Publish

- [ ] You are authenticated as the right npm account
- [ ] `npm whoami` shows the expected publisher
- [ ] Confirm the name is still available/owned: `npm view pi-governor versions`

```bash
npm whoami
npm publish          # prepublishOnly runs check + test first
```

`npm publish` is **irreversible** for a given version — unpublish is heavily
restricted. Bump and publish again rather than trying to overwrite.

## 7. Post-publish verification

- [ ] `npm view pi-governor version` shows the new version
- [ ] `npm view pi-governor keywords` includes `pi-package`
- [ ] Fresh install works end to end:

```bash
rm -rf /tmp/installed && mkdir -p /tmp/installed && cd /tmp/installed
npm init -y >/dev/null && npm install pi-governor
pi install npm:pi-governor
pi --help | grep governor-max-cost
```

- [ ] The package appears on the [pi gallery](https://pi.dev/packages)
      (driven by the `pi-package` keyword; can take a little while to index)
- [ ] `git tag v<version> && git push --tags`

## 8. If something is wrong

- **Bad package contents** — `npm deprecate pi-governor@<version> "reason"`,
  fix, bump patch, republish.
- **Runtime bug** — fix on `main`, bump patch, republish. Users on a version
  range pick it up; pinned users do not.
- **Regression in a released version** — add a test that reproduces it *first*,
  then fix, so it cannot come back.
