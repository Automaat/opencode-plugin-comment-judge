import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RULES_CHARS, rulesRoot, truncated } from "../src/rules.ts";

describe("rulesRoot", () => {
  const cases = [
    ["the worktree when there is one", "/repo", "/repo/packages/app", "/repo"],
    ["the directory when the worktree is missing", undefined, "/repo/app", "/repo/app"],
    ["the directory when the worktree is the filesystem root, as opencode reports outside git", "/", "/scratch", "/scratch"],
  ] as const;
  for (const [name, worktree, directory, expected] of cases) it(`uses ${name}`, () => assert.equal(rulesRoot(worktree, directory), expected));
});

describe("truncated", () => {
  it("cuts at the last line break within the limit, so no rule is left half written", () => {
    const line = `- ${"x".repeat(97)}\n`;
    const text = truncated(line.repeat(50));
    assert.ok(text.length <= RULES_CHARS);
    assert.equal(text, line.repeat(40).trimEnd());
  });

  it("cuts at the limit when there is no line break to cut at", () => {
    assert.equal(truncated("x".repeat(RULES_CHARS + 10)).length, RULES_CHARS);
  });
});
