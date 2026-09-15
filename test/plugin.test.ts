import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { load, runEdit, verdicts } from "./helpers.ts";

const COMMENTED = { filePath: "src/cart.ts", oldString: "  return 0;", newString: "  // Return the total\n  return total;" };

describe("tool.execute.before", () => {
  it("never asks the judge about an edit that adds no comments", async () => {
    const { hooks, calls } = await load(() => {
      throw new Error("the judge must not be asked");
    });
    const { args } = await runEdit(hooks, { filePath: "src/cart.ts", oldString: "  return 0;", newString: "  return 1;" });
    assert.equal(calls.created.length, 0);
    assert.equal(args.newString, "  return 1;");
  });

  it("ignores tools that do not edit files", async () => {
    const { hooks, calls } = await load(() => verdicts());
    await runEdit(hooks, { command: "echo // hi" }, { tool: "bash" });
    assert.equal(calls.created.length, 0);
  });

  it("writes a rewrite into the edit and tells the agent what the file holds", async () => {
    const { hooks, calls } = await load(() =>
      verdicts({ id: "c1", action: "rewrite", reason: "narrates the fix", rewrite: "SKUs compare case-insensitively." }),
    );
    const { args, note } = await runEdit(hooks, {
      filePath: "src/cart.ts",
      oldString: "  const sku = item.sku;",
      newString: "  // Fix: previously ABC-1 and abc-1 made two lines\n  const sku = item.sku.toLowerCase();",
    });
    assert.equal(args.newString, "  // SKUs compare case-insensitively.\n  const sku = item.sku.toLowerCase();");
    assert.match(note, /now "\/\/ SKUs compare case-insensitively\."/);
    assert.deepEqual(calls.deleted, ["judge-1"]);
  });

  it("removes a comment judged to restate the code", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "remove", reason: "restates the return" }));
    const { args, note } = await runEdit(hooks, { ...COMMENTED });
    assert.equal(args.newString, "  return total;");
    assert.match(note, /"\/\/ Return the total" removed/);
  });

  it("leaves a kept comment and the tool result alone", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "keep", reason: "explains why" }));
    const { args, note } = await runEdit(hooks, { ...COMMENTED });
    assert.equal(args.newString, COMMENTED.newString);
    assert.equal(note, "Edit applied successfully.");
  });

  it("treats a rewrite that matches the comment as written as keep", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "rewrite", reason: "already short", rewrite: "Return the total" }));
    const { args, note } = await runEdit(hooks, { ...COMMENTED });
    assert.equal(args.newString, COMMENTED.newString);
    assert.equal(note, "Edit applied successfully.");
  });

  it("changes comments inside an apply_patch", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "remove", reason: "restates the name" }));
    const patchText = "*** Begin Patch\n*** Add File: src/a.py\n+# adds the helper\n+def helper():\n+    return 1\n*** End Patch";
    const { args } = await runEdit(hooks, { patchText }, { tool: "apply_patch" });
    assert.equal(args.patchText, "*** Begin Patch\n*** Add File: src/a.py\n+def helper():\n+    return 1\n*** End Patch");
  });

  it("removes a markup comment from a Markdown edit", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "remove", reason: "narrates the change" }));
    const { args } = await runEdit(hooks, { filePath: "docs/a.md", oldString: "Old text.", newString: "<!--\n  Updated per review.\n-->\nNew text." });
    assert.equal(args.newString, "New text.");
  });

  it("rejects removing a docstring that is the whole body of a function", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "remove", reason: "restates the name" }));
    const output = { args: { filePath: "src/a.py", oldString: "def total():\n    pass", newString: 'def total():\n    """Returns the total."""' } };
    await assert.rejects(hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c" }, output), /cannot be changed in place/);
    assert.equal(output.args.newString, 'def total():\n    """Returns the total."""');
  });

  it("rejects an edit whose verdicts cannot be applied in place, and lets the same comments through once re-sent", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "rewrite", reason: "too long" }));
    const args = () => ({ filePath: "src/cart.ts", oldString: "const a = 1;", newString: "// a long story\nconst a = 2;" });
    await assert.rejects(
      hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c-1" }, { args: args() }),
      /cannot be changed in place/,
    );
    const { args: sent, note } = await runEdit(hooks, args(), { sessionID: "s", callID: "c-2" });
    assert.equal(sent.newString, args().newString);
    assert.match(note, /applied as sent/);
  });

  it("refuses an edit that only adds comments the judge removes, leaving its arguments as sent", async () => {
    const { hooks } = await load(() => verdicts({ id: "c1", action: "remove", reason: "restates the assignment" }));
    const output = { args: { filePath: "src/cart.ts", oldString: "const a = 1;", newString: "// set a\nconst a = 1;" } };
    await assert.rejects(hooks["tool.execute.before"]({ tool: "edit", sessionID: "s", callID: "c" }, output), /only adds comments/);
    assert.equal(output.args.newString, "// set a\nconst a = 1;");
  });

  it("writes the edit unjudged when the judge fails", async () => {
    const { hooks, calls } = await load(() => {
      throw new Error("provider down");
    });
    const { args } = await runEdit(hooks, { ...COMMENTED });
    assert.equal(args.newString, COMMENTED.newString);
    assert.deepEqual(calls.aborted, ["judge-1"]);
    assert.deepEqual(calls.deleted, ["judge-1"]);
    assert.ok(calls.logs.some((entry) => entry.level === "warn" && /provider down/.test(entry.extra?.reason)));
  });

  it("writes the edit unjudged when the judge is slower than timeoutMs", async () => {
    const { hooks, calls } = await load(() => new Promise(() => {}), { timeoutMs: 10 });
    const { args } = await runEdit(hooks, { ...COMMENTED });
    assert.equal(args.newString, COMMENTED.newString);
    assert.deepEqual(calls.aborted, ["judge-1"]);
  });

  it("does not judge edits made inside a judge session", async () => {
    const { hooks, calls } = await load(() => verdicts({ id: "c1", action: "keep", reason: "explains why" }));
    await runEdit(hooks, { ...COMMENTED });
    await runEdit(hooks, { ...COMMENTED }, { sessionID: "judge-1", callID: "call-2" });
    assert.equal(calls.created.length, 1);
  });

  it("asks as the build agent on the configured model, under the editing session, with its latest prompt", async () => {
    const { hooks, calls } = await load(() => verdicts({ id: "c1", action: "keep", reason: "explains why" }), {
      model: "anthropic/claude-haiku-4-5",
    });
    await hooks["chat.message"]({ sessionID: "session-1" }, { message: {}, parts: [{ type: "text", text: "Fix the SKU bug" }] });
    await runEdit(hooks, { ...COMMENTED });
    const [{ body }] = calls.prompted;
    assert.equal(body.agent, "build");
    assert.deepEqual(body.model, { providerID: "anthropic", modelID: "claude-haiku-4-5" });
    assert.match(body.parts[0].text, /<task>\nFix the SKU bug\n<\/task>/);
    assert.equal(calls.created[0].parentID, "session-1");
  });

  it("falls back to small_model when no model is configured", async () => {
    const { hooks, calls } = await load(() => verdicts({ id: "c1", action: "keep", reason: "explains why" }));
    await runEdit(hooks, { ...COMMENTED });
    assert.deepEqual(calls.prompted[0].body.model, { providerID: "cheap", modelID: "fast" });
  });
});
