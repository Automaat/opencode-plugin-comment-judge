import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_TIMEOUT_MS, settings } from "../src/options.ts";

function parse(options: Record<string, unknown> | undefined) {
  const warnings: string[] = [];
  return { resolved: settings(options, (message) => warnings.push(message)), warnings };
}

describe("settings", () => {
  it("defaults to small_model, the default timeout and no log file", () => {
    assert.deepEqual(parse(undefined), { resolved: { model: "", timeoutMs: DEFAULT_TIMEOUT_MS, log: "" }, warnings: [] });
  });

  it("takes every option when valid", () => {
    const { resolved, warnings } = parse({ model: " anthropic/claude-haiku-4-5 ", timeoutMs: 5000, log: "/tmp/judge.jsonl" });
    assert.deepEqual(resolved, { model: "anthropic/claude-haiku-4-5", timeoutMs: 5000, log: "/tmp/judge.jsonl" });
    assert.deepEqual(warnings, []);
  });

  it("keeps a model id that itself contains a slash", () => {
    assert.equal(parse({ model: "gateway/zai-org/GLM-5" }).resolved.model, "gateway/zai-org/GLM-5");
  });

  it("warns and falls back on each invalid option", () => {
    const { resolved, warnings } = parse({ model: "haiku", timeoutMs: -1, log: 3 });
    assert.deepEqual(resolved, { model: "", timeoutMs: DEFAULT_TIMEOUT_MS, log: "" });
    assert.equal(warnings.length, 3);
    assert.match(warnings[0] ?? "", /provider\/model/);
  });
});
