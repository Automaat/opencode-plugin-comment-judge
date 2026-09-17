import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { blocksOf } from "../src/comments.ts";
import { diffChange, parseDiff, untrackedDiff } from "../src/diff.ts";

const MODIFIED = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "index 1111111..2222222 100644",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1,0 +2,2 @@ export function total() {",
  "+  // Loop over the items",
  "+  // and add them up",
  "@@ -8 +10 @@ export function add() {",
  "-  return 0;",
  "+  return 1; // one, not zero",
  "",
].join("\n");

describe("parseDiff", () => {
  it("reads added and removed lines from every hunk of a modified file", () => {
    assert.deepEqual(parseDiff(MODIFIED), [
      {
        file: "src/cart.ts",
        from: "src/cart.ts",
        deleted: false,
        binary: false,
        added: [
          { line: 2, text: "  // Loop over the items" },
          { line: 3, text: "  // and add them up" },
          { line: 10, text: "  return 1; // one, not zero" },
        ],
        removed: ["  return 0;"],
      },
    ]);
  });

  it("counts new-file lines through context lines when hunks carry context", () => {
    const text = [
      "diff --git a/a.py b/a.py",
      "--- a/a.py",
      "+++ b/a.py",
      "@@ -3,3 +3,4 @@ def f():",
      " x = 1",
      "-y = 2",
      "+# why",
      "+y = 3",
      " z = 4",
      "\\ No newline at end of file",
    ].join("\n");
    assert.deepEqual(parseDiff(text)[0]?.added, [
      { line: 4, text: "# why" },
      { line: 5, text: "y = 3" },
    ]);
  });

  it("reads a new file, a deleted file and a binary file", () => {
    const text = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 0000000..92d5444",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+// new",
      "+x();",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "--- looks like a header",
      "diff --git a/logo.png b/logo.png",
      "index 88768ef..3e3315e 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    const [created, gone, binary] = parseDiff(text);
    assert.equal(created?.file, "new.ts");
    assert.deepEqual(created?.added.map(({ line }) => line), [1, 2]);
    assert.equal(gone?.deleted, true);
    assert.deepEqual(gone?.removed, ["-- looks like a header"]);
    assert.equal(binary?.file, "logo.png");
    assert.equal(binary?.binary, true);
    assert.equal(binary?.added.length, 0);
  });

  it("reads a renamed file under its new name, with or without changes", () => {
    const text = [
      "diff --git a/old.ts b/renamed.ts",
      "similarity index 66%",
      "rename from old.ts",
      "rename to renamed.ts",
      "--- a/old.ts",
      "+++ b/renamed.ts",
      "@@ -2,0 +3 @@ r2",
      "+// hi",
      "diff --git a/lib/a b.ts b/lib/c d.ts",
      "similarity index 100%",
      "rename from lib/a b.ts",
      "rename to lib/c d.ts",
    ].join("\n");
    const [changed, moved] = parseDiff(text);
    assert.equal(changed?.file, "renamed.ts");
    assert.equal(changed?.from, "old.ts");
    assert.deepEqual(changed?.added, [{ line: 3, text: "// hi" }]);
    assert.equal(moved?.file, "lib/c d.ts");
    assert.equal(moved?.from, "lib/a b.ts");
    assert.equal(moved?.added.length, 0);
  });

  it("reads names with spaces, which end in a tab, and quoted names with escapes", () => {
    const text = [
      "diff --git a/sp ace.ts b/sp ace.ts",
      "--- a/sp ace.ts\t",
      "+++ b/sp ace.ts\t",
      "@@ -1,0 +2 @@ a",
      "+// new",
      'diff --git "a/q\\"t\\303\\251.ts" "b/q\\"t\\303\\251.ts"',
      '--- "a/q\\"t\\303\\251.ts"',
      '+++ "b/q\\"t\\303\\251.ts"',
      "@@ -1,0 +2 @@",
      "+# z",
    ].join("\n");
    assert.deepEqual(
      parseDiff(text).map(({ file }) => file),
      ["sp ace.ts", 'q"té.ts'],
    );
  });

  it("drops the carriage return of CRLF lines", () => {
    const text = ["diff --git a/w.ts b/w.ts", "--- a/w.ts", "+++ b/w.ts", "@@ -1,0 +2 @@ x", "+// c", ""].join("\r\n");
    assert.deepEqual(parseDiff(text)[0]?.added, [{ line: 2, text: "// c" }]);
  });
});

describe("diffChange", () => {
  it("reads the whole file as the after side and marks only the lines the diff adds", () => {
    const [diff] = parseDiff(MODIFIED);
    const content = [
      "export function total() {",
      "  // Loop over the items",
      "  // and add them up",
      "  return items.length;",
      "}",
      "",
      "",
      "",
      "export function add() {",
      "  return 1; // one, not zero",
      "}",
      "",
    ].join("\n");
    const change = diff && diffChange(diff, content);
    assert.equal(change?.after.length, 12);
    assert.deepEqual(
      change?.added?.flatMap((added, index) => (added ? [index + 1] : [])),
      [2, 3, 10],
    );
    const blocks = blocksOf(change ? [change] : []);
    assert.deepEqual(
      blocks.map(({ start, raw, code }) => ({ start, raw, code })),
      [
        { start: 1, raw: ["  // Loop over the items", "  // and add them up"], code: "" },
        { start: 9, raw: ["  return 1; // one, not zero"], code: "  return 1;" },
      ],
    );
    assert.match(blocks[0]?.context ?? "", /^export function total\(\) \{\n {2}\/\/ Loop/);
  });

  it("reads CRLF files", () => {
    const [diff] = parseDiff(["diff --git a/w.ts b/w.ts", "--- a/w.ts", "+++ b/w.ts", "@@ -1,0 +2 @@", "+// c"].join("\n"));
    const change = diff && diffChange(diff, "x();\r\n// c\r\ny();\r\n");
    assert.deepEqual(change?.after, ["x();", "// c", "y();", ""]);
    assert.equal(blocksOf(change ? [change] : []).length, 1);
  });

  it("returns nothing when the file no longer holds the added lines", () => {
    const [diff] = parseDiff(MODIFIED);
    assert.equal(diff && diffChange(diff, "export function total() {\n  return 0;\n}\n"), undefined);
  });

  it("finds a whole docstring from the file when the diff adds only its middle line", () => {
    const text = ["diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py", "@@ -2,0 +3 @@", "+    Fixed the bug from the ticket."].join("\n");
    const content = 'def f():\n    """Return one.\n    Fixed the bug from the ticket.\n    """\n    return 1\n';
    const [diff] = parseDiff(text);
    const blocks = blocksOf(diff ? [diffChange(diff, content)].flatMap((change) => (change ? [change] : [])) : []);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0]?.span?.syntax, "docstring");
    assert.deepEqual(blocks[0]?.raw, ['    """Return one.', "    Fixed the bug from the ticket.", '    """']);
  });

  it("leaves a docstring alone when none of its lines were added", () => {
    const text = ["diff --git a/a.py b/a.py", "--- a/a.py", "+++ b/a.py", "@@ -4,0 +5 @@", "+    x = 2"].join("\n");
    const content = 'def f():\n    """Return one."""\n    x = 1\n    return 1\n    x = 2\n';
    const [diff] = parseDiff(text);
    const change = diff && diffChange(diff, content);
    assert.equal(blocksOf(change ? [change] : []).length, 0);
  });

  it("treats a comment the diff moves within the file as kept", () => {
    const text = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +0,0 @@", "-// why it is odd", "@@ -3,0 +3 @@", "+// why it is odd"].join("\n");
    const [diff] = parseDiff(text);
    const change = diff && diffChange(diff, "a();\nb();\n// why it is odd\nodd();\n");
    assert.equal(blocksOf(change ? [change] : []).length, 0);
  });

  it("does not take an old copy of a repeated comment line for the added one", () => {
    const text = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -0,0 +1,3 @@", "+/**", "+ * Adds.", "+ */"].join("\n");
    const content = "/**\n * Adds.\n */\nexport function add() {}\n/**\n * Old.\n */\nexport function old() {}\n";
    const [diff] = parseDiff(text);
    const change = diff && diffChange(diff, content);
    assert.deepEqual(
      blocksOf(change ? [change] : []).map(({ start, raw }) => ({ start, raw })),
      [{ start: 0, raw: ["/**", " * Adds.", " */"] }],
    );
  });
});

describe("untrackedDiff", () => {
  it("adds every line of a new text file and skips binary content", () => {
    assert.deepEqual(untrackedDiff("n.ts", "// a\nx();\n")?.added, [
      { line: 1, text: "// a" },
      { line: 2, text: "x();" },
    ]);
    assert.equal(untrackedDiff("n.bin", "a\0b"), undefined);
  });
});
