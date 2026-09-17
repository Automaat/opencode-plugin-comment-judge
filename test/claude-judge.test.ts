import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";

import { claudeArgs, claudeSettings, judgeWithClaude, parseClaudeResult } from "../src/claude/judge.ts";
import { instructions, render, SCHEMA } from "../src/judge.ts";
import { fakeClaude, POSIX_ONLY, result } from "./fake-claude.ts";
import { blockOf } from "./helpers.ts";

const request = { blocks: [blockOf(["// increment i"])], task: "Count the items", rules: "- Remove banners." };
const settings = { model: "haiku", timeoutMs: 5000 };
const remove = { verdicts: [{ id: "c1", action: "remove", reason: "restates" }] };

describe("claudeSettings", () => {
  it("defaults to haiku and the plugin's timeout", () => {
    assert.deepEqual(claudeSettings({}, assert.fail), { model: "haiku", timeoutMs: 30_000 });
  });

  it("reads the model and timeout from the environment", () => {
    assert.deepEqual(claudeSettings({ COMMENT_JUDGE_MODEL: " sonnet ", COMMENT_JUDGE_TIMEOUT_MS: "12000" }, assert.fail), {
      model: "sonnet",
      timeoutMs: 12_000,
    });
  });

  it("warns about a timeout that is not a positive number and keeps the default", () => {
    const warnings: string[] = [];
    const resolved = claudeSettings({ COMMENT_JUDGE_TIMEOUT_MS: "soon" }, (message) => warnings.push(message));
    assert.equal(resolved.timeoutMs, 30_000);
    assert.match(warnings[0] ?? "", /COMMENT_JUDGE_TIMEOUT_MS must be a positive number/);
  });
});

describe("claudeArgs", () => {
  it("asks one turn with the judge instructions and schema, and nothing loaded that could edit files or recurse", () => {
    assert.deepEqual(claudeArgs(settings, request), [
      "-p",
      render(request.blocks, request.task),
      "--model",
      "haiku",
      "--system-prompt",
      instructions(request.rules),
      "--output-format",
      "json",
      "--json-schema",
      JSON.stringify(SCHEMA),
      "--tools",
      "",
      "--strict-mcp-config",
      "--setting-sources",
      "",
      "--safe-mode",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]);
  });
});

describe("parseClaudeResult", () => {
  it("reads structured output, the model and the cost", () => {
    assert.deepEqual(parseClaudeResult(JSON.stringify(result(remove))), {
      verdicts: [{ id: "c1", action: "remove", reason: "restates" }],
      structured: true,
      model: "claude-haiku-4-5",
      cost: 0.001,
    });
  });

  it("falls back to JSON in the result text", () => {
    const parsed = parseClaudeResult(JSON.stringify({ type: "result", is_error: false, result: `Verdicts:\n${JSON.stringify(remove)}` }));
    assert.equal(parsed.structured, false);
    assert.equal(parsed.verdicts[0]?.action, "remove");
  });

  it("refuses an error result and output that is not JSON", () => {
    assert.throws(() => parseClaudeResult(JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "" })), /error_max_turns/);
    assert.throws(() => parseClaudeResult("Not logged in"), /without JSON: Not logged in/);
  });
});

describe("judgeWithClaude", () => {
  it("runs claude from PATH with the arguments, the guard set, thinking and the title request off, stdin closed, outside the project", POSIX_ONLY, async () => {
    const { env, calls } = fakeClaude(result(remove));
    env.MAX_THINKING_TOKENS = "32000";
    const judgement = await judgeWithClaude(settings, request, env);
    assert.deepEqual(judgement.verdicts, [{ id: "c1", action: "remove", reason: "restates" }]);
    const [call] = calls();
    assert.deepEqual(call?.args, claudeArgs(settings, request));
    assert.equal(call?.guard, "1");
    assert.equal(call?.thinking, "0");
    assert.equal(call?.title, "1");
    assert.equal(call?.devNull, true);
    assert.equal(call?.cwd.replace(/^\/private/, ""), tmpdir().replace(/^\/private/, ""));
  });

  it("gives up after the timeout", POSIX_ONLY, async () => {
    const { env } = fakeClaude(result(remove), { sleepMs: 5000 });
    await assert.rejects(judgeWithClaude({ model: "haiku", timeoutMs: 100 }, request, env), /judge timed out after 100ms/);
  });

  it("fails with the output of a claude that exits non-zero", POSIX_ONLY, async () => {
    const { env } = fakeClaude("Invalid API key", { exitCode: 1 });
    await assert.rejects(judgeWithClaude(settings, request, env), /claude exited with 1: Invalid API key/);
  });

  it("fails when claude is not installed", async () => {
    await assert.rejects(judgeWithClaude(settings, request, { PATH: tmpdir() }), /ENOENT/);
  });
});
