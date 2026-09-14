import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changesOf } from "../src/changes.ts";
import { blocksOf } from "../src/comments.ts";
import { applyInPlace, formatted, replaceableInPlace, replacement } from "../src/rewrite.ts";
import type { Flag } from "../src/types.ts";
import { blockOf } from "./helpers.ts";

describe("formatted", () => {
  it("writes line comments at the original indentation", () => {
    assert.deepEqual(formatted(blockOf(["    // a", "    // b"]), "one\ntwo"), ["    // one", "    // two"]);
  });

  it("uses the file's own marker", () => {
    assert.deepEqual(formatted(blockOf(["  # long story"], "a.py"), "short"), ["  # short"]);
  });

  it("collapses a doc comment to one line when the rewrite is one line", () => {
    assert.deepEqual(formatted(blockOf(["  /**", "   * long", "   */"]), "short"), ["  /** short */"]);
  });

  it("keeps a multi-line doc comment shaped as one", () => {
    assert.deepEqual(formatted(blockOf(["  /**", "   * long", "   */"]), "one\ntwo"), ["  /**", "   * one", "   * two", "   */"]);
  });

  it("keeps the closer of a doc comment tail", () => {
    assert.deepEqual(formatted(blockOf(["   * long", "   */"]), "short"), ["   * short", "   */"]);
  });

  it("rewrites or drops a trailing comment and keeps its code", () => {
    const block = blockOf(["x(); // long"], "a.ts", "x();");
    assert.deepEqual(formatted(block, "why"), ["x(); // why"]);
    assert.deepEqual(formatted(block, ""), ["x();"]);
  });

  it("removes a full-line comment entirely", () => {
    assert.deepEqual(formatted(blockOf(["// a"]), ""), []);
  });

  it("strips markers the model added and cannot close a block comment early", () => {
    const lines = formatted(blockOf(["/**", " * a", " */"]), "// short */ evil();");
    assert.deepEqual(lines, ["/** short * / evil(); */"]);
    assert.equal(lines.join("\n").split("*/").length, 2);
  });
});

describe("replaceableInPlace", () => {
  const cases = [
    ["line comments", ["// a", "// b"], "", true],
    ["a whole block comment", ["/**", " * a", " */"], "", true],
    ["a block comment opened but not closed in the edit", ["/**", " * a"], "", false],
    ["the tail of a block comment", [" * a", " */"], "", true],
    ["middle lines of a block comment", [" * a"], "", true],
    ["a trailing comment", ["x(); // a"], "x();", true],
  ] as const;
  for (const [name, raw, code, expected] of cases)
    it(`${expected ? "accepts" : "refuses"} ${name}`, () => assert.equal(replaceableInPlace(blockOf([...raw], "a.ts", code)), expected));
});

describe("replacement", () => {
  it("has nothing to write for a rewrite without text", () => {
    assert.equal(replacement({ block: blockOf(["// a"]), verdict: { id: "c1", action: "rewrite", reason: "r" } }), undefined);
  });

  it("has nothing to write for a block it cannot replace", () => {
    assert.equal(replacement({ block: blockOf(["/**", " * a"]), verdict: { id: "c1", action: "remove", reason: "r" } }), undefined);
  });
});

describe("applyInPlace", () => {
  it("commits every verdict for a file in one pass", () => {
    const args = { filePath: "a.ts", oldString: "x();\ny();", newString: "// a\nx();\n// b\ny();" };
    const blocks = blocksOf(changesOf("edit", args, "/"));
    const flags: Flag[] = blocks.map((block, index) => {
      const flag: Flag = {
        block,
        verdict: index === 0 ? { id: block.id, action: "remove", reason: "r" } : { id: block.id, action: "rewrite", reason: "r", rewrite: "why b" },
      };
      flag.lines = replacement(flag);
      return flag;
    });
    applyInPlace(flags);
    assert.equal(args.newString, "x();\n// why b\ny();");
  });
});
