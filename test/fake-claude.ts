import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export const POSIX_ONLY = { skip: process.platform === "win32" ? "a script named claude cannot be spawned without a shell on Windows" : false };

/**
 * Puts an executable named claude first on PATH that records its arguments, working directory and guard variable, then prints `answer` or sleeps for `sleepMs`.
 */
export function fakeClaude(answer: unknown, { sleepMs = 0, exitCode = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "comment-judge-fake-claude-"));
  const record = join(dir, "calls.jsonl");
  const script = `#!${process.execPath}
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), guard: process.env.COMMENT_JUDGE_ACTIVE ?? null, thinking: process.env.MAX_THINKING_TOKENS ?? null, title: process.env.CLAUDE_CODE_DISABLE_TERMINAL_TITLE ?? null, devNull: require("node:fs").fstatSync(0).isCharacterDevice() }) + "\\n");
setTimeout(() => {
  process.stdout.write(${JSON.stringify(typeof answer === "string" ? answer : JSON.stringify(answer))});
  process.exitCode = ${exitCode};
}, ${sleepMs});
`;
  writeFileSync(join(dir, "claude"), script);
  chmodSync(join(dir, "claude"), 0o755);
  const { COMMENT_JUDGE_ACTIVE: _guard, ...inherited } = process.env;
  const env: NodeJS.ProcessEnv = { ...inherited, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}` };
  const calls = (): { args: string[]; cwd: string; guard: string | null; thinking: string | null; title: string | null; devNull: boolean }[] => {
    try {
      return readFileSync(record, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { env, calls };
}

export const result = (structured: unknown, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify(structured),
  structured_output: structured,
  total_cost_usd: 0.001,
  modelUsage: { "claude-haiku-4-5": {} },
  ...extra,
});
