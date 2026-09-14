import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addedLines, blocksOf, commentOf, markerOf } from "../src/comments.ts";
import { changeOf } from "./helpers.ts";

const DIRECTIVE = ["// eslint", "disable-next-line no-console"].join("-");

describe("markerOf", () => {
  const cases = [
    ["src/a.ts", "//"],
    ["src/a.go", "//"],
    ["scripts/run.sh", "#"],
    ["app/main.py", "#"],
    ["deploy/Dockerfile", "#"],
    ["Makefile", "#"],
    ["db/query.sql", "--"],
  ] as const;
  for (const [file, marker] of cases) it(`${file} uses ${marker}`, () => assert.equal(markerOf(file), marker));
});

describe("commentOf", () => {
  const cases = [
    ["a full-line comment", "  // why", "a.ts", { code: "", text: "// why" }],
    ["a hash comment in Python", "    # why", "a.py", { code: "", text: "# why" }],
    ["a dash comment in SQL", "-- why", "q.sql", { code: "", text: "-- why" }],
    ["a doc comment opener", "/** doc", "a.ts", { code: "", text: "/** doc" }],
    ["a doc comment continuation", " * more", "a.ts", { code: "", text: "* more" }],
    ["a trailing comment", "const a = 1; // why", "a.ts", { code: "const a = 1;", text: "// why" }],
    ["a directive", DIRECTIVE, "a.ts", { code: "", text: DIRECTIVE }],
    ["a marker inside a string", 'const url = "a // b";', "a.ts", null],
    ["a URL", 'fetch("https://example.com")', "a.ts", null],
    ["a star that is Python code", "* args", "a.py", null],
    ["a blank line", "   ", "a.ts", null],
  ] as const;
  for (const [name, line, file, expected] of cases) it(`reads ${name}`, () => assert.deepEqual(commentOf(line, file), expected));
});

describe("addedLines", () => {
  it("counts lines as a multiset, so a repeated line is added only past its old count", () => {
    assert.deepEqual(addedLines(["a", "b", "a"], ["a", "a", "a", "c"]), [false, false, true, true]);
  });
});

describe("blocksOf", () => {
  it("groups consecutive added comment lines and ignores comments already in the file", () => {
    const change = changeOf(["// old", "// new one", "// new two", "x()", "y() // trailing"], "a.ts", ["// old", "x()"]);
    const blocks = blocksOf([change]);
    assert.deepEqual(
      blocks.map(({ id, start, raw, code, text }) => ({ id, start, raw, code, text })),
      [
        { id: "c1", start: 1, raw: ["// new one", "// new two"], code: "", text: "// new one\n// new two" },
        { id: "c2", start: 4, raw: ["y() // trailing"], code: "y()", text: "// trailing" },
      ],
    );
  });

  it("keeps a trailing comment out of the block above it", () => {
    const blocks = blocksOf([changeOf(["// a", "b() // c"])]);
    assert.deepEqual(
      blocks.map(({ text }) => text),
      ["// a", "// c"],
    );
  });

  it("gives the judge the code around each comment", () => {
    const after = ["l0", "l1", "l2", "l3", "// why", "l5", "l6", "l7", "l8", "l9", "l10", "l11"];
    const [block] = blocksOf([changeOf(after, "a.ts", after.filter((line) => line !== "// why"))]);
    assert.equal(block?.context, "l1\nl2\nl3\n// why\nl5\nl6\nl7\nl8\nl9\nl10");
  });

  it("numbers blocks across every file in the edit", () => {
    const blocks = blocksOf([changeOf(["// a"], "a.ts"), changeOf(["# b"], "b.py")]);
    assert.deepEqual(
      blocks.map(({ id, change }) => `${id}:${change.file}`),
      ["c1:a.ts", "c2:b.py"],
    );
  });
});
