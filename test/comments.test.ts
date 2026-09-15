import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { addedLines, blocksOf, commentOf, markerOf, spansOf } from "../src/comments.ts";
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

  it("reads no line comments in Markdown, where * starts a bullet", () => {
    assert.equal(commentOf("* a bullet", "a.md"), null);
    assert.equal(commentOf("// not code", "a.mdx"), null);
  });
});

describe("spansOf", () => {
  const shape = (file: string, lines: string[]) =>
    spansOf(lines, file).map(({ syntax, start, end, opener, closer, sole }) => ({ syntax, start, end, opener, closer, sole }));
  const docstring = (start: number, end: number, sole: boolean, opener = '"""', closer = '"""') => ({
    syntax: "docstring",
    start,
    end,
    opener,
    closer,
    sole,
  });

  it("finds the docstrings of a module, a class and a function", () => {
    const lines = [
      '"""Cart helpers."""',
      "",
      "import os",
      "",
      "class Empty(Exception):",
      '    """Raised when the cart is empty."""',
      "",
      "def total(",
      "    items,  # (priced)",
      ") -> int:",
      "    # summed below",
      "    r'''Sum the items.",
      "",
      "    # Not a comment here.",
      "    '''",
      "    return sum(items)",
    ];
    assert.deepEqual(shape("a.py", lines), [docstring(0, 1, false), docstring(5, 6, true), docstring(11, 15, false, "r'''", "'''")]);
  });

  it("reads an escaped quote as part of the docstring", () => {
    assert.deepEqual(shape("a.py", ["def f():", '    """Says \\""" twice."""', "    return 1"]), [docstring(1, 2, false)]);
  });

  it("finds no docstring in strings that are not the first statement or that do not take whole lines", () => {
    const lines = [
      "def f():",
      "    x = 1",
      '    """After code."""',
      "def g():",
      '    f"""Formatted {x}."""',
      "def h():",
      '    """Followed by code.""".strip()',
      "def i():",
      '    """Never closed.',
    ];
    assert.deepEqual(shape("a.py", lines), []);
    assert.deepEqual(shape("a.ts", ['"""Not Python."""']), []);
  });

  it("finds JSX comments on one line or several", () => {
    const lines = ["<div>", "  {/* Single line. */}", "  {/*", "    Several", "    lines.", "  */}", "  {/* Before code. */}<span />", "</div>"];
    const jsx = (start: number, end: number) => ({ syntax: "jsx", start, end, opener: "{/*", closer: "*/}", sole: false });
    assert.deepEqual(shape("a.tsx", lines), [jsx(1, 2), jsx(2, 6)]);
    for (const file of ["a.jsx", "a.mdx"]) assert.deepEqual(shape(file, ["{/* why */}"]), [jsx(0, 1)]);
    assert.deepEqual(shape("a.ts", ["{/* why */}"]), []);
  });

  it("finds markup comments on one line or several, outside Markdown code fences", () => {
    const lines = ["# Title", "<!-- Single line. -->", "* a bullet", "<!--", "  Several", "  lines.", "-->", "```html", "<!-- Sample. -->", "```", "<!-- Before text. --> text"];
    const markup = (start: number, end: number) => ({ syntax: "markup", start, end, opener: "<!--", closer: "-->", sole: false });
    assert.deepEqual(shape("a.md", lines), [markup(1, 2), markup(3, 7)]);
    for (const file of ["a.html", "a.htm", "a.xml", "a.vue", "a.svelte", "a.mdx"]) assert.deepEqual(shape(file, ["<!-- why -->"]), [markup(0, 1)]);
    assert.deepEqual(shape("a.ts", ["<!-- why -->"]), []);
  });
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

  it("judges a docstring as one block, even where its blank and closing lines are already in the file", () => {
    const after = ["def f():", '    """Sum the items.', "", "    Long story.", '    """', "    return 1"];
    const before = ["def g():", '    """Other.', "", '    """', "    return 2"];
    const blocks = blocksOf([changeOf(after, "a.py", before)]);
    assert.deepEqual(
      blocks.map(({ id, start, raw, code, text, span }) => ({ id, start, raw, code, text, syntax: span?.syntax })),
      [{ id: "c1", start: 1, raw: after.slice(1, 5), code: "", text: '"""Sum the items.\n\nLong story.\n"""', syntax: "docstring" }],
    );
  });

  it("leaves a docstring alone when the file already has its lines in that order", () => {
    const before = ["def f():", '    """Sum.', '    """', "    return 1"];
    assert.deepEqual(blocksOf([changeOf([...before.slice(0, 3), "    return 2"], "a.py", before)]), []);
  });

  it("does not read lines inside a docstring as comments", () => {
    const blocks = blocksOf([changeOf(['"""', "# Heading", '"""', "# real"], "a.py")]);
    assert.deepEqual(
      blocks.map(({ text }) => text),
      ['"""\n# Heading\n"""', "# real"],
    );
  });

  it("reads JSX and markup comments over several lines as one block each", () => {
    const blocks = blocksOf([changeOf(["<div>", "  // a", "  {/*", "    * Why.", "  */}", "</div>"], "a.tsx"), changeOf(["<!--", "* Why.", "-->"], "a.md")]);
    assert.deepEqual(
      blocks.map(({ id, text }) => `${id}:${text}`),
      ["c1:// a", "c2:{/*\n* Why.\n*/}", "c3:<!--\n* Why.\n-->"],
    );
  });

  it("numbers blocks across every file in the edit", () => {
    const blocks = blocksOf([changeOf(["// a"], "a.ts"), changeOf(["# b"], "b.py")]);
    assert.deepEqual(
      blocks.map(({ id, change }) => `${id}:${change.file}`),
      ["c1:a.ts", "c2:b.py"],
    );
  });
});
