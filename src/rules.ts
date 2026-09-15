import { readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

export const RULES_FILE = ".comment-judge.md";

/**
 * Longest repository rules sent to the judge. About 1000 tokens: more than the default instructions, room for a few dozen rules, and small enough that a fast model on every commented edit stays fast and cheap.
 */
export const RULES_CHARS = 4000;

export type Log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => void;

/**
 * Directory the rules file is read from: the worktree, or the directory opencode runs in when there is no worktree.
 */
export function rulesRoot(worktree: string | undefined, directory: string): string {
  return worktree && worktree !== "/" ? worktree : directory;
}

/**
 * Cuts rules to RULES_CHARS, at the last line break within the limit when there is one.
 */
export function truncated(text: string): string {
  const cut = text.slice(0, RULES_CHARS);
  const lineEnd = cut.lastIndexOf("\n");
  return lineEnd > 0 ? cut.slice(0, lineEnd).trimEnd() : cut;
}

function statOf(path: string): Stats | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Reads the rules file under root now, and returns a function giving its current rules that re-reads the file only when its modification time or size changed.
 */
export function repositoryRules(root: string, log: Log): () => string {
  const path = join(root, RULES_FILE);
  let version: string | undefined;
  let rules = "";

  const current = () => {
    const stat = statOf(path);
    const seen = stat ? `${stat.mtimeMs}:${stat.size}` : "";
    if (seen === version) return rules;
    const first = version === undefined;
    version = seen;
    rules = "";

    if (!stat) {
      log("info", first ? "no repository rules" : "repository rules removed", { path });
      return rules;
    }
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("warn", "repository rules cannot be read; judging without them", { path, reason });
      return rules;
    }
    rules = text.length > RULES_CHARS ? truncated(text) : text;
    log("info", first ? "repository rules in effect" : "repository rules reloaded", { path, bytes: stat.size, chars: rules.length });
    if (rules.length < text.length)
      log("warn", `repository rules truncated to ${rules.length} of ${text.length} characters`, { path, limit: RULES_CHARS });
    return rules;
  };

  current();
  return current;
}
