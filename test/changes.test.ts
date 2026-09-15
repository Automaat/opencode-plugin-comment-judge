import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { changesOf } from "../src/changes.ts";

describe("changesOf", () => {
  it("reads an edit and writes a commit back into newString", () => {
    const args = { filePath: "a.ts", oldString: "x();", newString: "// a\nx();\ny();" };
    const [change] = changesOf("edit", args, "/");
    assert.deepEqual(change?.before, ["x();"]);
    assert.deepEqual(change?.after, ["// a", "x();", "y();"]);
    change?.commit([{ start: 0, length: 1, lines: ["// why"] }]);
    assert.equal(args.newString, "// why\nx();\ny();");
  });

  it("keeps CRLF line endings", () => {
    const args = { filePath: "a.ts", oldString: "x();", newString: "// a\r\nx();\r\ny();" };
    const [change] = changesOf("edit", args, "/");
    change?.commit([{ start: 0, length: 1, lines: [] }]);
    assert.equal(args.newString, "x();\r\ny();");
  });

  it("applies several ops without shifting each other", () => {
    const args = { filePath: "a.ts", oldString: "", newString: "// a\nx();\n// b\ny();" };
    const [change] = changesOf("edit", args, "/");
    change?.commit([
      { start: 0, length: 1, lines: [] },
      { start: 2, length: 1, lines: ["// one", "// two"] },
    ]);
    assert.equal(args.newString, "x();\n// one\n// two\ny();");
  });

  it("reads every edit of a multiedit and commits each into its own newString", () => {
    const args = {
      filePath: "a.ts",
      edits: [
        { oldString: "x", newString: "// a\nx" },
        { oldString: "y", newString: "// b\ny" },
      ],
    };
    const changes = changesOf("multiedit", args, "/");
    assert.equal(changes.length, 2);
    changes[1]?.commit([{ start: 0, length: 1, lines: [] }]);
    assert.equal(args.edits[0]?.newString, "// a\nx");
    assert.equal(args.edits[1]?.newString, "y");
  });

  it("compares a write against the file on disk, resolved from the working directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "comment-judge-"));
    writeFileSync(join(directory, "a.ts"), "// keep\nx();\n");
    const args = { filePath: "a.ts", content: "// keep\n// added\nx();\n" };
    const [change] = changesOf("write", args, directory);
    assert.deepEqual(change?.before, ["// keep", "x();", ""]);
    change?.commit([{ start: 1, length: 1, lines: [] }]);
    assert.equal(args.content, "// keep\nx();\n");
  });

  it("treats a write to a new file as all added", () => {
    const [change] = changesOf("write", { filePath: "missing/a.ts", content: "// a" }, mkdtempSync(join(tmpdir(), "comment-judge-")));
    assert.deepEqual(change?.before, [""]);
  });

  it("reads every file of an apply_patch and commits into the patch text", () => {
    const args = {
      patchText: [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        " const a = 1;",
        "-const b = 2;",
        "+// narrates b",
        "+const b = 3;",
        "*** Add File: src/new.py",
        "+# adds a file",
        "+x = 1",
        "*** End Patch",
        "",
      ].join("\n"),
    };
    const [update, add] = changesOf("apply_patch", args, "/");
    assert.equal(update?.file, "src/a.ts");
    assert.deepEqual(update?.before, ["const a = 1;", "const b = 2;"]);
    assert.deepEqual(update?.after, ["const a = 1;", "// narrates b", "const b = 3;"]);
    assert.equal(add?.file, "src/new.py");
    assert.deepEqual(add?.after, ["# adds a file", "x = 1"]);

    update?.commit([{ start: 1, length: 1, lines: ["// why b"] }]);
    add?.commit([{ start: 0, length: 1, lines: [] }]);
    assert.equal(
      args.patchText,
      "*** Begin Patch\n*** Update File: src/a.ts\n@@\n const a = 1;\n-const b = 2;\n+// why b\n+const b = 3;\n*** Add File: src/new.py\n+x = 1\n*** End Patch\n",
    );
  });

  it("removes context lines an op replaces instead of dropping them from the patch", () => {
    const args = {
      patchText: ["*** Begin Patch", "*** Update File: a.py", "@@", " def f():", '     """Old', "+    new line.", '     """', "*** End Patch"].join("\n"),
    };
    const [change] = changesOf("apply_patch", args, "/");
    change?.commit([{ start: 1, length: 3, lines: ['    """Short."""'] }]);
    assert.equal(
      args.patchText,
      ["*** Begin Patch", "*** Update File: a.py", "@@", " def f():", '-    """Old', '+    """Short."""', '-    """', "*** End Patch"].join("\n"),
    );
  });

  it("ignores tools it does not know and arguments it cannot read", () => {
    assert.deepEqual(changesOf("bash", { command: "ls" }, "/"), []);
    assert.deepEqual(changesOf("edit", undefined, "/"), []);
    assert.deepEqual(changesOf("edit", { oldString: "a" }, "/"), []);
  });
});
