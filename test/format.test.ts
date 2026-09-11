import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY,
  formatDuration,
  formatLimitValue,
  formatPercent,
  formatRatio,
  formatTokens,
  formatUsd,
} from "../src/format.ts";

describe("formatUsd", () => {
  it("uses two decimals for amounts of a dollar or more", () => {
    assert.equal(formatUsd(5), "5.00");
    assert.equal(formatUsd(1.234), "1.23");
  });

  it("keeps precision for sub-dollar amounts", () => {
    assert.equal(formatUsd(0.5), "0.500");
    assert.equal(formatUsd(0.0034), "0.0034");
    assert.equal(formatUsd(0), "0.00");
  });

  it("renders a placeholder for unknown values", () => {
    assert.equal(formatUsd(null), EMPTY);
    assert.equal(formatUsd(Number.NaN), EMPTY);
  });
});

describe("formatDuration", () => {
  it("drops lower units once a higher one is present", () => {
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(12 * 60_000), "12m");
    assert.equal(formatDuration(90 * 60_000), "1h30m");
    assert.equal(formatDuration(2 * 3_600_000), "2h");
  });

  it("treats negatives and null as unknown", () => {
    assert.equal(formatDuration(-1), EMPTY);
    assert.equal(formatDuration(null), EMPTY);
  });
});

describe("formatTokens", () => {
  it("scales through k, M and B", () => {
    assert.equal(formatTokens(950), "950");
    assert.equal(formatTokens(1234), "1.2k");
    assert.equal(formatTokens(45_000), "45k");
    assert.equal(formatTokens(1_500_000), "1.5M");
    assert.equal(formatTokens(2_500_000_000), "2.5B");
  });

  it("handles zero and unknown", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(null), EMPTY);
  });
});

describe("percent and ratio helpers", () => {
  it("rounds to whole percentages", () => {
    assert.equal(formatPercent(34.6), "35%");
    assert.equal(formatRatio(0.824), "82%");
    assert.equal(formatPercent(null), EMPTY);
  });
});

describe("formatLimitValue", () => {
  it("uses the units of each limit", () => {
    assert.equal(formatLimitValue("time", 90 * 60_000), "1h30m");
    assert.equal(formatLimitValue("cost", 5), "$5.00");
    assert.equal(formatLimitValue("context", 85.4), "85%");
    assert.equal(formatLimitValue("tokens", 2_000_000), "2.0M");
    assert.equal(formatLimitValue("turns", 50), "50");
  });
});
