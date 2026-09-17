import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

import { instructions, parseVerdicts, render, SCHEMA } from "../judge.ts";
import { DEFAULT_TIMEOUT_MS } from "../options.ts";
import type { Block, Verdict } from "../types.ts";

export const DEFAULT_CLAUDE_MODEL = "haiku";

/**
 * Set in the environment of the judge's `claude -p`, so the hook exits at once if that session loads it anyway.
 */
export const GUARD_ENV = "COMMENT_JUDGE_ACTIVE";

const PREVIEW_CHARS = 200;

/**
 * Environment of the judge's `claude -p`: the recursion guard, no extended thinking, which took most of a haiku call's 20 seconds in testing, and no background request for a session title.
 */
export const JUDGE_ENV = { [GUARD_ENV]: "1", MAX_THINKING_TOKENS: "0", CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1" };

export type ClaudeSettings = { model: string; timeoutMs: number };

export type ClaudeJudgement = { verdicts: Verdict[]; model: string; promptMs: number; cost: number | undefined; structured: boolean };

export type ClaudeRequest = { blocks: Block[]; task: string; rules: string };

export function claudeSettings(env: NodeJS.ProcessEnv, warn: (message: string) => void): ClaudeSettings {
  const resolved: ClaudeSettings = { model: DEFAULT_CLAUDE_MODEL, timeoutMs: DEFAULT_TIMEOUT_MS };
  const model = env.COMMENT_JUDGE_MODEL?.trim();
  if (model) resolved.model = model;

  const timeout = env.COMMENT_JUDGE_TIMEOUT_MS;
  if (timeout !== undefined && timeout.trim() !== "") {
    const ms = Number(timeout);
    if (Number.isFinite(ms) && ms > 0) resolved.timeoutMs = ms;
    else
      warn(
        `comment-judge: COMMENT_JUDGE_TIMEOUT_MS must be a positive number of milliseconds, got ${JSON.stringify(timeout)}; using ${DEFAULT_TIMEOUT_MS}`,
      );
  }
  return resolved;
}

/**
 * Arguments for a single-turn `claude -p` that answers with verdicts and nothing else: no tools, no MCP servers, no settings files, hooks, plugins or CLAUDE.md, and no saved session.
 */
export function claudeArgs(settings: ClaudeSettings, request: ClaudeRequest): string[] {
  return [
    "-p",
    render(request.blocks, request.task),
    "--model",
    settings.model,
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
  ];
}

function run(args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: tmpdir(),
      env: { ...env, ...JUDGE_ENV },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`judge timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`claude exited with ${code}: ${(stderr || stdout).trim().slice(0, PREVIEW_CHARS)}`));
    });
  });
}

/**
 * Reads the JSON `claude -p --output-format json` prints: the schema-validated `structured_output` when present, the verdicts in the text of `result` otherwise.
 */
export function parseClaudeResult(stdout: string): { verdicts: Verdict[]; structured: boolean; model: string; cost: number | undefined } {
  let result: any;
  try {
    result = JSON.parse(stdout);
  } catch {
    throw new Error(`claude answered without JSON: ${stdout.slice(0, PREVIEW_CHARS)}`);
  }
  if (result?.is_error) throw new Error(`judge failed: ${result.subtype ?? "error"} ${String(result.result ?? "")}`.trim());
  const structured = Array.isArray(result?.structured_output?.verdicts);
  const verdicts = structured
    ? parseVerdicts({ structured: result.structured_output }, [])
    : parseVerdicts({}, [{ type: "text", text: String(result?.result ?? "") }]);
  return {
    verdicts,
    structured,
    model: Object.keys(result?.modelUsage ?? {}).join(","),
    cost: typeof result?.total_cost_usd === "number" ? result.total_cost_usd : undefined,
  };
}

export async function judgeWithClaude(settings: ClaudeSettings, request: ClaudeRequest, env: NodeJS.ProcessEnv): Promise<ClaudeJudgement> {
  const started = performance.now();
  const stdout = await run(claudeArgs(settings, request), env, settings.timeoutMs);
  return { ...parseClaudeResult(stdout), promptMs: Math.round(performance.now() - started) };
}
