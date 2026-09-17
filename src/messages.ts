import type { Block, Flag } from "./types.ts";

const FIRST_LINE_CHARS = 100;

const firstLine = (block: Block) => (block.text.split("\n")[0] ?? "").slice(0, FIRST_LINE_CHARS);

const oneLine = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" / ");

function suggestions(flags: Flag[]): string[] {
  return flags.map(({ block, verdict }) => {
    let fix = "remove";
    if (verdict.action === "rewrite")
      fix = verdict.rewrite?.trim()
        ? `rewrite as "${oneLine(verdict.rewrite)}"`
        : "rewrite it to state only the lasting reason, or remove it";
    return `- ${block.change.file}: "${firstLine(block)}" -> ${fix} (${verdict.reason})`;
  });
}

export function rejection(flags: Flag[]): string {
  return [
    `comment-judge rejected this edit: ${flags.length} comment(s) need changing and cannot be changed in place. Re-issue the same edit with each one removed or replaced as suggested; keep the code unchanged.`,
    ...suggestions(flags),
  ].join("\n");
}

export function onlyRejectedComments(flags: Flag[]): string {
  return [
    "comment-judge rejected this edit: it only adds comments, and none of them earn their place. Leave the code as it is.",
    ...suggestions(flags),
  ].join("\n");
}

export function appliedDespiteRepeat(flags: Flag[]): string {
  return [
    `comment-judge: the edit was applied as sent, but ${flags.length} comment(s) still need changing. Fix them in a follow-up edit; do not change the code.`,
    ...suggestions(flags),
  ].join("\n");
}

export function rewrittenNote(flags: Flag[], field = "oldString"): string {
  const lines = flags.map(({ block, verdict, lines: written }) => {
    const now = written && written.length > 0 ? `now "${oneLine(written.join("\n"))}"` : "removed";
    return `- ${block.change.file}: "${firstLine(block)}" ${now} (${verdict.reason})`;
  });
  return [
    `comment-judge changed comments in this edit before it was written. The file holds the versions below; match them in any later ${field}:`,
    ...lines,
  ].join("\n");
}
