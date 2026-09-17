import { readFileSync } from "node:fs";

export const TASK_CHARS = 2000;

const GENERATED = /^<(?:command-|local-command-|system-reminder|task-notification)/;

function promptOf(entry: any): string {
  if (entry?.type !== "user" || entry.isMeta || entry.message?.role !== "user") return "";
  const { content } = entry.message;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part: any) => (part?.type === "text" && typeof part.text === "string" ? [part.text] : []))
    .join("\n");
}

/**
 * The latest prompt the user typed in a Claude Code transcript, cut to its last TASK_CHARS characters. The transcript format is not a documented contract, so anything unreadable yields no task.
 */
export function latestPrompt(path: unknown): string {
  if (typeof path !== "string" || !path) return "";
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split("\n");
  } catch {
    return "";
  }
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[index] ?? "");
    } catch {
      continue;
    }
    const text = promptOf(entry).trim();
    if (text && !GENERATED.test(text)) return text.slice(-TASK_CHARS);
  }
  return "";
}
