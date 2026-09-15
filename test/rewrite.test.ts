import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { changesOf } from "../src/changes.ts";
import { blocksOf } from "../src/comments.ts";
import { applyInPlace, formatted, replaceableInPlace, replacement } from "../src/rewrite.ts";
import type { Block, Flag } from "../src/types.ts";
import { blockOf, changeOf } from "./helpers.ts";

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

function constructOf(after: string[], file: string): Block {
  const [block] = blocksOf([changeOf(after, file)]);
  assert.ok(block?.span);
  return block;
}

const METHOD = ["class Cart:", "    def total(self):", '        """Sum the items.', "", "        Long story.", '        """', "        return 1"];

describe("formatted docstrings", () => {
  it("rewrites or removes a docstring in place, keeping its quotes and indentation", () => {
    const block = constructOf(METHOD, "a.py");
    assert.deepEqual(formatted(block, "Total price."), ['        """Total price."""']);
    assert.deepEqual(formatted(block, "Total price.\nIn cents."), ['        """Total price.', "        In cents.", '        """']);
    assert.deepEqual(formatted(block, ""), []);
  });

  it("keeps a string prefix and single quotes, and strips the quotes the model added", () => {
    const block = constructOf(["def f():", "    r'''Match \\d+ in a long way.'''", "    return 1"], "a.py");
    assert.deepEqual(formatted(block, "'''Match \\d+.'''"), ["    r'''Match \\d+.'''"]);
  });

  it("cannot close a docstring early or escape its closing quotes", () => {
    const block = constructOf(["def f():", '    """Doc."""', "    return 1"], "a.py");
    const lines = formatted(block, 'Short.""" ; import os ; """ \\x and "quoted" \\');
    assert.deepEqual(lines, ['    """Short." "" ; import os ; " "" \\\\x and "quoted" \\\\ """']);
    assert.equal(lines.join("\n").split('"""').length, 3);
    assert.deepEqual(formatted(block, 'Returns "x"'), ['    """Returns "x" """']);
  });
});

describe("formatted JSX comments", () => {
  const JSX = ["<div>", "  {/*", "    Long story.", "  */}", "</div>"];

  it("rewrites or removes a JSX comment in place", () => {
    const block = constructOf(JSX, "a.tsx");
    assert.deepEqual(formatted(block, "Why."), ["  {/* Why. */}"]);
    assert.deepEqual(formatted(block, "One.\nTwo."), ["  {/*", "    One.", "    Two.", "  */}"]);
    assert.deepEqual(formatted(block, ""), []);
  });

  it("cannot close a JSX comment early", () => {
    const lines = formatted(constructOf(JSX, "a.tsx"), "{/* a */} <script /> {/*");
    assert.deepEqual(lines, ["  {/* a * /} <script /> {/* */}"]);
    assert.equal(lines.join("\n").split("*/").length, 2);
  });
});

describe("formatted markup comments", () => {
  const MARKUP = ["# Title", "<!--", "Long story.", "-->", "Text."];

  it("rewrites or removes a markup comment in place", () => {
    const block = constructOf(MARKUP, "a.md");
    assert.deepEqual(formatted(block, "<!-- Why. -->"), ["<!-- Why. -->"]);
    assert.deepEqual(formatted(block, "One.\nTwo."), ["<!--", "  One.", "  Two.", "-->"]);
    assert.deepEqual(formatted(block, ""), []);
  });

  it("cannot close a markup comment early", () => {
    const lines = formatted(constructOf(MARKUP, "a.html"), "<!-- a --> <script>x()</script> --!> b -->");
    assert.deepEqual(lines, ["<!-- a -- > <script>x()</script> --! > b -->"]);
    assert.equal(lines.join("\n").split("-->").length, 2);
    assert.ok(!lines.join("\n").includes("--!>"));
  });

  it("writes no double hyphen inside an XML comment", () => {
    const lines = formatted(constructOf(["<root>", "  <!-- Long. -->", "</root>"], "a.xml"), "a -- b --> c");
    assert.deepEqual(lines, ["  <!-- a - - b - -> c -->"]);
    assert.equal(lines.join("\n").split("--").length, 3);
  });
});

describe("replaceableInPlace", () => {
  it("accepts a whole docstring, JSX comment or markup comment", () => {
    assert.equal(replaceableInPlace(constructOf(METHOD, "a.py")), true);
    assert.equal(replaceableInPlace(constructOf(["{/*", "  why", "*/}"], "a.jsx")), true);
    assert.equal(replaceableInPlace(constructOf(["<!--", "  why", "-->"], "a.vue")), true);
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

  it("will not empty a body whose only statement is the docstring, but still rewrites it", () => {
    const block = constructOf(["class Empty(Exception):", '    """Raised when the cart is empty."""', "", "x = 1"], "a.py");
    assert.equal(replacement({ block, verdict: { id: "c1", action: "remove", reason: "r" } }), undefined);
    assert.equal(replacement({ block, verdict: { id: "c1", action: "rewrite", reason: "r", rewrite: '"""' } }), undefined);
    assert.deepEqual(replacement({ block, verdict: { id: "c1", action: "rewrite", reason: "r", rewrite: "Empty cart." } }), [
      '    """Empty cart."""',
    ]);
  });

  it("removes a docstring that has code after it in the body", () => {
    assert.deepEqual(replacement({ block: constructOf(METHOD, "a.py"), verdict: { id: "c1", action: "remove", reason: "r" } }), []);
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

  it("replaces a whole docstring, including lines the file already had", () => {
    const args = {
      filePath: "a.py",
      oldString: 'def f():\n    """Old.\n\n    """\n    return 1',
      newString: 'def f():\n    """New.\n\n    Longer.\n    """\n    return 1',
    };
    const [block] = blocksOf(changesOf("edit", args, "/"));
    assert.ok(block);
    const flag: Flag = { block, verdict: { id: block.id, action: "rewrite", reason: "r", rewrite: "Short." } };
    flag.lines = replacement(flag);
    applyInPlace([flag]);
    assert.equal(args.newString, 'def f():\n    """Short."""\n    return 1');
  });
});
