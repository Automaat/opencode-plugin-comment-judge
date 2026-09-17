import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { claudeEdit } from "../src/claude/changes.ts";

describe("claudeEdit", () => {
  it("reads an Edit and commits into a copy of its input", () => {
    const toolInput = { file_path: "/repo/a.ts", old_string: "x();", new_string: "// a\nx();", replace_all: false };
    const edit = claudeEdit("Edit", toolInput);
    const [change] = edit?.changes ?? [];
    assert.equal(change?.file, "/repo/a.ts");
    assert.deepEqual(change?.before, ["x();"]);
    assert.deepEqual(change?.after, ["// a", "x();"]);
    change?.commit([{ start: 0, length: 1, lines: ["// why"] }]);
    assert.deepEqual(edit?.input, { file_path: "/repo/a.ts", old_string: "x();", new_string: "// why\nx();", replace_all: false });
    assert.equal(toolInput.new_string, "// a\nx();");
  });

  it("reports an Edit whose commit leaves it replacing text with itself", () => {
    const edit = claudeEdit("Edit", { file_path: "/repo/a.ts", old_string: "x();", new_string: "// a\nx();" });
    assert.equal(edit?.unchanged(), false);
    edit?.changes[0]?.commit([{ start: 0, length: 1, lines: [] }]);
    assert.equal(edit?.unchanged(), true);
  });

  it("reads a Write against the file on disk", () => {
    const file = join(mkdtempSync(join(tmpdir(), "comment-judge-")), "a.py");
    writeFileSync(file, "x = 1\n");
    const edit = claudeEdit("Write", { file_path: file, content: "# set x\nx = 1\n" });
    const [change] = edit?.changes ?? [];
    assert.deepEqual(change?.before, ["x = 1", ""]);
    change?.commit([{ start: 0, length: 1, lines: [] }]);
    assert.equal(edit?.input.content, "x = 1\n");
    assert.equal(edit?.unchanged(), false);
  });

  it("reads a Write of a new file as all added", () => {
    const edit = claudeEdit("Write", { file_path: join(tmpdir(), "comment-judge-missing", "a.ts"), content: "// a" });
    assert.deepEqual(edit?.changes[0]?.before, [""]);
  });

  it("reads every edit of a MultiEdit", () => {
    const edit = claudeEdit("MultiEdit", {
      file_path: "/repo/a.ts",
      edits: [
        { old_string: "a();", new_string: "// one\na();" },
        { old_string: "b();", new_string: "b(); // two", replace_all: true },
      ],
    });
    assert.equal(edit?.changes.length, 2);
    edit?.changes[1]?.commit([{ start: 0, length: 1, lines: ["b();"] }]);
    assert.deepEqual(edit?.input.edits, [
      { old_string: "a();", new_string: "// one\na();" },
      { old_string: "b();", new_string: "b();", replace_all: true },
    ]);
    assert.equal(edit?.unchanged(), true);
  });

  it("ignores other tools and malformed input", () => {
    assert.equal(claudeEdit("Bash", { command: "echo // hi" }), undefined);
    assert.equal(claudeEdit("Edit", null), undefined);
    assert.equal(claudeEdit("Edit", { old_string: "a", new_string: "b" }), undefined);
    assert.equal(claudeEdit("MultiEdit", { file_path: "/repo/a.ts" }), undefined);
  });
});
