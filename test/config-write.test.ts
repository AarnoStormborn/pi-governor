import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { mergeRawConfig, writeConfigFile } from "../src/config.ts";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-governor-"));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("mergeRawConfig", () => {
  it("creates a document from an empty base", () => {
    const result = mergeRawConfig(undefined, { limits: { costUsd: 5 } });
    assert.deepEqual(result, { limits: { costUsd: 5 } });
  });

  it("preserves keys this version does not understand", () => {
    const existing = { $schema: "./schema.json", futureOption: { nested: true }, limits: { costUsd: 1 } };
    const result = mergeRawConfig(existing, { limits: { costUsd: 5 } });
    assert.equal(result.$schema, "./schema.json");
    assert.deepEqual(result.futureOption, { nested: true });
    assert.deepEqual(result.limits, { costUsd: 5 });
  });

  it("merges nested sections instead of replacing them", () => {
    const result = mergeRawConfig(
      { limits: { costUsd: 1, turns: 10 }, enforcement: { onToolCall: "allow" } },
      { limits: { costUsd: 5 } },
    );
    assert.deepEqual(result.limits, { costUsd: 5, turns: 10 });
    assert.deepEqual(result.enforcement, { onToolCall: "allow" });
  });

  it("writes scalar top-level values", () => {
    const result = mergeRawConfig({}, { warnRatio: 0.5, timeMode: "active", enabled: false });
    assert.equal(result.warnRatio, 0.5);
    assert.equal(result.timeMode, "active");
    assert.equal(result.enabled, false);
  });

  it("does not overwrite a section with a non-object", () => {
    const result = mergeRawConfig({ limits: "garbage" }, { limits: { costUsd: 2 } });
    assert.deepEqual(result.limits, { costUsd: 2 });
  });

  it("leaves untouched keys alone when a patch is empty", () => {
    const existing = { limits: { costUsd: 1 }, custom: 7 };
    assert.deepEqual(mergeRawConfig(existing, {}), existing);
  });
});

describe("writeConfigFile", () => {
  it("creates the file and its parent directory", () => {
    const dir = tempDir();
    const path = join(dir, ".pi", "governor.json");

    const result = writeConfigFile(path, { limits: { costUsd: 5 } });
    assert.equal(result.ok, true);

    const written = JSON.parse(readFileSync(path, "utf8")) as unknown;
    assert.deepEqual(written, { limits: { costUsd: 5 } });
  });

  it("writes human-friendly JSON with a trailing newline", () => {
    const dir = tempDir();
    const path = join(dir, "governor.json");
    writeConfigFile(path, { limits: { costUsd: 5 } });

    const text = readFileSync(path, "utf8");
    assert.ok(text.endsWith("\n"));
    assert.ok(text.includes('\n  "limits"'), "should be indented for readability");
  });

  it("preserves existing content across successive writes", () => {
    const dir = tempDir();
    const path = join(dir, "governor.json");

    writeConfigFile(path, { limits: { costUsd: 5 } });
    writeConfigFile(path, { limits: { turns: 20 } });
    writeConfigFile(path, { enforcement: { onPreflight: "refuse" } });

    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    assert.deepEqual(written.limits, { costUsd: 5, turns: 20 });
    assert.equal(written.enforcement.onPreflight, "refuse");
  });

  it("round-trips a null limit as an explicit clear", () => {
    const dir = tempDir();
    const path = join(dir, "governor.json");

    writeConfigFile(path, { limits: { costUsd: 5, turns: 10 } });
    writeConfigFile(path, { limits: { costUsd: null } });

    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
    assert.equal(written.limits.costUsd, null);
    assert.equal(written.limits.turns, 10);
  });

  it("treats an empty file as an empty document", () => {
    const dir = tempDir();
    const path = join(dir, "governor.json");
    writeFileSync(path, "   \n", "utf8");

    const result = writeConfigFile(path, { limits: { costUsd: 1 } });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { limits: { costUsd: 1 } });
  });

  it("reports invalid JSON instead of throwing or clobbering it", () => {
    const dir = tempDir();
    const path = join(dir, "governor.json");
    writeFileSync(path, "{ not json", "utf8");

    const result = writeConfigFile(path, { limits: { costUsd: 1 } });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /could not read existing config/);
    // The broken file is left intact so the user can fix it.
    assert.equal(readFileSync(path, "utf8"), "{ not json");
  });
});
