import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { handle, type HookDeps, type HookInput } from "../src/claude/hook.ts";
import type { ClaudeRequest } from "../src/claude/judge.ts";
import { TASK_CHARS } from "../src/claude/transcript.ts";
import { RULES_FILE } from "../src/rules.ts";
import type { Verdict } from "../src/types.ts";

const EDIT = { file_path: "/repo/src/cart.ts", old_string: "  return 0;", new_string: "  // Return the total\n  return total;", replace_all: false };

function hook(answer: (request: ClaudeRequest) => Verdict[] | Promise<Verdict[]>, projectDir?: string) {
  const requests: ClaudeRequest[] = [];
  const warnings: string[] = [];
  const deps: HookDeps = {
    judge: async (request) => {
      requests.push(request);
      return answer(request);
    },
    stateRoot: join(mkdtempSync(join(tmpdir(), "comment-judge-hook-")), "state"),
    projectDir,
    warn: (message) => {
      warnings.push(message);
    },
  };
  let calls = 0;
  const pre = (toolInput: unknown, extra: Partial<HookInput> = {}) => {
    calls += 1;
    return handle(
      { hook_event_name: "PreToolUse", session_id: "session-1", cwd: "/repo", tool_name: "Edit", tool_input: toolInput, tool_use_id: `toolu_${calls}`, ...extra },
      deps,
    );
  };
  const post = (toolUseId = `toolu_${calls}`, extra: Partial<HookInput> = {}) =>
    handle({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: "Edit", tool_use_id: toolUseId, ...extra }, deps);
  return { pre, post, requests, warnings };
}

const verdict = (action: Verdict["action"], rewrite?: string): Verdict[] => [{ id: "c1", action, reason: "why", ...(rewrite ? { rewrite } : {}) }];

describe("PreToolUse", () => {
  it("returns nothing, without judging, for an edit that adds no comments or a tool that does not edit", async () => {
    const { pre, requests } = hook(() => assert.fail("judged"));
    assert.equal(await pre({ ...EDIT, new_string: "  return total;" }), undefined);
    assert.equal(await pre({ command: "echo // hi" }, { tool_name: "Bash" }), undefined);
    assert.equal(requests.length, 0);
  });

  it("returns nothing when every comment is kept", async () => {
    const { pre, post } = hook(() => verdict("keep"));
    assert.equal(await pre(EDIT), undefined);
    assert.equal(await post(), undefined);
  });

  it("rewrites the input in place, leaves the permission decision to Claude Code, and hands the note to PostToolUse once", async () => {
    const { pre, post } = hook(() => verdict("rewrite", "Totals include tax."));
    assert.deepEqual(await pre(EDIT), {
      systemMessage: "comment-judge: 1 of 1 comment block(s) removed or rewritten",
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...EDIT, new_string: "  // Totals include tax.\n  return total;" } },
    });
    const note = await post();
    assert.equal(
      (note?.hookSpecificOutput as any)?.additionalContext,
      'comment-judge changed comments in this edit before it was written. The file holds the versions below; match them in any later old_string:\n- /repo/src/cart.ts: "// Return the total" now "// Totals include tax." (why)',
    );
    assert.equal((note?.hookSpecificOutput as any)?.hookEventName, "PostToolUse");
    assert.equal(await post("toolu_1"), undefined);
  });

  it("denies with suggestions when a verdict cannot be applied in place, then lets the same comments through with a note", async () => {
    const { pre, post } = hook(() => verdict("rewrite"));
    const denied = await pre(EDIT);
    assert.equal((denied?.hookSpecificOutput as any)?.permissionDecision, "deny");
    assert.match((denied?.hookSpecificOutput as any)?.permissionDecisionReason, /^comment-judge rejected this edit: 1 comment\(s\) need changing and cannot be changed in place/);
    assert.equal(denied?.systemMessage, "comment-judge: edit rejected: 1 comment(s) to fix");
    assert.equal(await post(), undefined);

    assert.equal(await pre(EDIT), undefined);
    const note = await post();
    assert.match((note?.hookSpecificOutput as any)?.additionalContext, /^comment-judge: the edit was applied as sent, but 1 comment\(s\) still need changing/);
  });

  it("denies an Edit left with only removed comments, with the existing message", async () => {
    const { pre } = hook(() => verdict("remove"));
    const denied = await pre({ ...EDIT, old_string: "const a = 1;", new_string: "// set a\nconst a = 1;" });
    assert.match((denied?.hookSpecificOutput as any)?.permissionDecisionReason, /it only adds comments, and none of them earn their place/);
  });

  it("judges each edit of a MultiEdit and a Write", async () => {
    const { pre } = hook(() => verdict("remove"));
    const multi = await pre({ file_path: "/repo/a.py", edits: [{ old_string: "x = 1", new_string: "# set x\nx = 2" }] }, { tool_name: "MultiEdit" });
    assert.deepEqual((multi?.hookSpecificOutput as any)?.updatedInput, { file_path: "/repo/a.py", edits: [{ old_string: "x = 1", new_string: "x = 2" }] });
    const written = await pre({ file_path: join(tmpdir(), "comment-judge-none", "b.sh"), content: "# say hi\necho hi\n" }, { tool_name: "Write" });
    assert.equal((written?.hookSpecificOutput as any)?.updatedInput.content, "echo hi\n");
  });

  it("writes the edit unjudged and warns the user when the judge fails", async () => {
    const { pre, post, warnings } = hook(() => {
      throw new Error("judge timed out after 10ms");
    });
    assert.deepEqual(await pre(EDIT), { systemMessage: "comment-judge: judge failed, edit written unjudged: judge timed out after 10ms" });
    assert.deepEqual(warnings, ["comment-judge: judge failed, edit written unjudged: judge timed out after 10ms"]);
    assert.equal(await post(), undefined);
  });

  it("sends the project's rules and the latest prompt from the transcript", async () => {
    const project = mkdtempSync(join(tmpdir(), "comment-judge-project-"));
    writeFileSync(join(project, RULES_FILE), "- Keep TODOs.\n");
    const transcript = join(project, "transcript.jsonl");
    const lines = [
      { type: "user", message: { role: "user", content: "Old prompt" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
      { type: "user", message: { role: "user", content: [{ type: "text", text: `${"x".repeat(TASK_CHARS)}Fix the cart total` }] } },
      { type: "user", isMeta: true, message: { role: "user", content: "Caveat: meta" } },
      { type: "user", message: { role: "user", content: "<local-command-stdout>done</local-command-stdout>" } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0", content: "Edited" }] } },
    ];
    writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\nnot json\n`);
    const { pre, requests } = hook(() => verdict("keep"), project);
    await pre(EDIT, { transcript_path: transcript, cwd: "/elsewhere" });
    assert.equal(requests[0]?.rules, "- Keep TODOs.");
    assert.equal(requests[0]?.task.length, TASK_CHARS);
    assert.ok(requests[0]?.task.endsWith("Fix the cart total"));
  });

  it("reads rules from cwd without a project directory, and judges without a task when the transcript is unreadable", async () => {
    const project = mkdtempSync(join(tmpdir(), "comment-judge-project-"));
    writeFileSync(join(project, RULES_FILE), "- Remove banners.");
    const { pre, requests } = hook(() => verdict("keep"));
    await pre(EDIT, { cwd: project, transcript_path: join(project, "missing.jsonl") });
    assert.equal(requests[0]?.rules, "- Remove banners.");
    assert.equal(requests[0]?.task, "");
  });
});

describe("other events", () => {
  it("returns nothing for PostToolUse without a note and for events it does not handle", async () => {
    const { post } = hook(() => verdict("keep"));
    assert.equal(await post("toolu_unknown"), undefined);
    assert.equal(await handle({ hook_event_name: "Stop" }, { judge: async () => assert.fail("judged"), stateRoot: tmpdir(), projectDir: undefined, warn: assert.fail }), undefined);
  });
});
