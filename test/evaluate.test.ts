import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blocksOf } from "../src/comments.ts";
import { evaluate } from "../src/evaluate.ts";
import type { Change } from "../src/types.ts";

function edited(after: string, before = "") {
  const state = { text: after, restored: 0 };
  const change: Change = {
    file: "src/cart.ts",
    before: before.split("\n"),
    after: after.split("\n"),
    commit: (ops) => {
      const lines = after.split("\n");
      for (const op of [...ops].sort((a, b) => b.start - a.start)) lines.splice(op.start, op.length, ...op.lines);
      state.text = lines.join("\n");
    },
  };
  const edit = {
    unchanged: () => state.text === before,
    restore: () => {
      state.text = after;
      state.restored += 1;
    },
  };
  return { blocks: blocksOf([change]), edit, state };
}

describe("evaluate", () => {
  it("keeps the edit when no verdict asks for a change", () => {
    const { blocks, edit, state } = edited("// explains why\nreturn total;", "return total;");
    const outcome = evaluate(blocks, [{ id: "c1", action: "keep", reason: "why" }], edit, new Set());
    assert.deepEqual(outcome, { kind: "kept" });
    assert.equal(state.text, "// explains why\nreturn total;");
  });

  it("applies verdicts in place and returns the note for the agent", () => {
    const { blocks, edit, state } = edited("// Return the total\nreturn total;", "return 0;");
    const outcome = evaluate(blocks, [{ id: "c1", action: "remove", reason: "restates" }], edit, new Set());
    assert.equal(outcome.kind, "rewritten");
    assert.equal(state.text, "return total;");
    assert.match(outcome.kind === "rewritten" ? outcome.note : "", /match them in any later oldString:\n- src\/cart\.ts: "\/\/ Return the total" removed/);
  });

  it("names the edit field the note tells the agent to match", () => {
    const { blocks, edit } = edited("// Return the total\nreturn total;", "return 0;");
    const outcome = evaluate(blocks, [{ id: "c1", action: "remove", reason: "restates" }], edit, new Set(), "old_string");
    assert.match(outcome.kind === "rewritten" ? outcome.note : "", /any later old_string:/);
  });

  it("restores and rejects an edit left with nothing to change, then lets the same comments through", () => {
    const { blocks, edit, state } = edited("// set a\nconst a = 1;", "const a = 1;");
    const rejected = new Set<string>();
    const verdicts = [{ id: "c1", action: "remove" as const, reason: "restates" }];

    const first = evaluate(blocks, verdicts, edit, rejected);
    assert.equal(first.kind, "rejected");
    assert.match(first.kind === "rejected" ? first.reason : "", /only adds comments/);
    assert.equal(state.restored, 1);
    assert.equal(rejected.size, 1);

    const second = evaluate(blocks, verdicts, edit, rejected);
    assert.equal(second.kind, "repeated");
    assert.match(second.kind === "repeated" ? second.note : "", /applied as sent/);
  });

  it("rejects verdicts that cannot be applied in place without touching the edit", () => {
    const { blocks, edit, state } = edited("// a long story\nconst a = 2;", "const a = 1;");
    const outcome = evaluate(blocks, [{ id: "c1", action: "rewrite", reason: "too long" }], edit, new Set());
    assert.equal(outcome.kind, "rejected");
    assert.match(outcome.kind === "rejected" ? outcome.reason : "", /cannot be changed in place/);
    assert.equal(state.text, "// a long story\nconst a = 2;");
    assert.equal(state.restored, 0);
  });
});
