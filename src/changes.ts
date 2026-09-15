import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import type { Change, Op } from "./types.ts";

export const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "apply_patch", "patch"]);

const PATCH_FILE = /^\*\*\* (?:Add|Update) File: (.+)$/;

function spliced(lines: string[], ops: Op[], eol: string): string {
  const copy = [...lines];
  for (const op of [...ops].sort((a, b) => b.start - a.start)) copy.splice(op.start, op.length, ...op.lines);
  return copy.join(eol);
}

function textChange(file: string, before: string, after: string, write: (text: string) => void): Change {
  const eol = after.includes("\r\n") ? "\r\n" : "\n";
  const lines = after.split(eol);
  return {
    file,
    before: before.split(/\r?\n/),
    after: lines,
    commit: (ops) => write(spliced(lines, ops, eol)),
  };
}

function currentContent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function patchChanges(args: { patchText?: unknown }): Change[] {
  const patch: (string | null)[] = String(args.patchText ?? "").split("\n");
  const changes: Change[] = [];
  let current: { change: Change; map: number[] } | null = null;

  for (const [index, line] of patch.entries()) {
    const text = line ?? "";
    const header = PATCH_FILE.exec(text);
    if (header) {
      const map: number[] = [];
      const change: Change = {
        file: (header[1] ?? "").trim(),
        before: [],
        after: [],
        commit: (ops) => {
          for (const op of ops) {
            for (const [offset, patchIndex] of map.slice(op.start, op.start + op.length).entries()) {
              const replaced = patch[patchIndex] ?? "";
              const lines = replaced.startsWith("+") ? [] : [`-${replaced.slice(1)}`];
              if (offset === 0) lines.push(...op.lines.map((written) => `+${written}`));
              patch[patchIndex] = lines.length > 0 ? lines.join("\n") : null;
            }
          }
          args.patchText = patch.filter((kept) => kept !== null).join("\n");
        },
      };
      current = { change, map };
      changes.push(change);
      continue;
    }
    if (text.startsWith("*** Move to:")) continue;
    if (text.startsWith("***")) {
      current = null;
      continue;
    }
    if (!current || text.startsWith("@@")) continue;
    const content = text.slice(1);
    if (text.startsWith("-")) {
      current.change.before.push(content);
      continue;
    }
    current.change.after.push(content);
    current.map.push(index);
    if (!text.startsWith("+")) current.change.before.push(content);
  }
  return changes;
}

export function changesOf(tool: string, args: any, cwd: string): Change[] {
  if (!args || typeof args !== "object") return [];
  if (tool === "edit" && typeof args.filePath === "string")
    return [
      textChange(args.filePath, String(args.oldString ?? ""), String(args.newString ?? ""), (text) => {
        args.newString = text;
      }),
    ];
  if (tool === "multiedit" && Array.isArray(args.edits))
    return args.edits.map((edit: any) =>
      textChange(String(edit.filePath ?? args.filePath ?? ""), String(edit.oldString ?? ""), String(edit.newString ?? ""), (text) => {
        edit.newString = text;
      }),
    );
  if (tool === "write" && typeof args.filePath === "string") {
    const path = isAbsolute(args.filePath) ? args.filePath : resolve(cwd, args.filePath);
    return [
      textChange(args.filePath, currentContent(path), String(args.content ?? ""), (text) => {
        args.content = text;
      }),
    ];
  }
  if (tool === "apply_patch" || tool === "patch") return patchChanges(args);
  return [];
}
