import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { fakeClaude, POSIX_ONLY, result } from "./fake-claude.ts";

const BIN = resolve(import.meta.dirname, "../src/claude.ts");
const EDIT = { file_path: "/repo/src/cart.ts", old_string: "  return 0;", new_string: "  // Return the total\n  return total;" };
const remove = { verdicts: [{ id: "c1", action: "remove", reason: "restates the return" }] };

function runHook(input: unknown, env: NodeJS.ProcessEnv) {
  const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", BIN], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env,
    encoding: "utf8",
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
}

function scratchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const temp = mkdtempSync(join(tmpdir(), "comment-judge-main-"));
  return { ...env, TMPDIR: temp, TMP: temp, TEMP: temp, CLAUDE_PROJECT_DIR: temp };
}

const pre = (toolUseId: string) => ({
  hook_event_name: "PreToolUse",
  session_id: "session-1",
  cwd: "/repo",
  tool_name: "Edit",
  tool_input: EDIT,
  tool_use_id: toolUseId,
});

describe("comment-judge-claude", () => {
  it("exits at once without output or a judge call inside the judge's own claude", () => {
    const { env, calls } = fakeClaude(result(remove));
    const run = runHook(pre("toolu_1"), scratchEnv({ ...env, COMMENT_JUDGE_ACTIVE: "1" }));
    assert.deepEqual(run, { code: 0, stdout: "", stderr: "" });
    assert.equal(calls().length, 0);
  });

  it("rewrites in one process and hands the note to PostToolUse in the next", POSIX_ONLY, () => {
    const { env, calls } = fakeClaude(result(remove));
    const shared = scratchEnv(env);

    const before = runHook(pre("toolu_1"), shared);
    assert.equal(before.code, 0);
    assert.deepEqual(JSON.parse(before.stdout).hookSpecificOutput, {
      hookEventName: "PreToolUse",
      updatedInput: { ...EDIT, new_string: "  return total;" },
    });
    assert.equal(calls().length, 1);

    const after = runHook({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: "Edit", tool_use_id: "toolu_1" }, shared);
    assert.match(JSON.parse(after.stdout).hookSpecificOutput.additionalContext, /"\/\/ Return the total" removed \(restates the return\)/);
    const again = runHook({ hook_event_name: "PostToolUse", session_id: "session-1", tool_name: "Edit", tool_use_id: "toolu_1" }, shared);
    assert.equal(again.stdout, "");
  });

  it("remembers a rejection across processes", POSIX_ONLY, () => {
    const { env } = fakeClaude(result({ verdicts: [{ id: "c1", action: "rewrite", reason: "too long" }] }));
    const shared = scratchEnv(env);
    assert.equal(JSON.parse(runHook(pre("toolu_1"), shared).stdout).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(runHook(pre("toolu_2"), shared).stdout, "");
  });

  it("uses COMMENT_JUDGE_MODEL", POSIX_ONLY, () => {
    const { env, calls } = fakeClaude(result(remove));
    runHook(pre("toolu_1"), scratchEnv({ ...env, COMMENT_JUDGE_MODEL: "sonnet" }));
    const args = calls()[0]?.args ?? [];
    assert.equal(args[args.indexOf("--model") + 1], "sonnet");
  });

  it("lets the edit through with a warning when the input is not JSON", () => {
    const run = runHook("not json", scratchEnv(process.env));
    assert.equal(run.code, 0);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /^comment-judge: hook failed, edit left as sent: /);
  });
});
