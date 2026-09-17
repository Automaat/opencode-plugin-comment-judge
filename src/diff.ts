import type { Change } from "./types.ts";

export type AddedLine = { line: number; text: string };

export type FileDiff = {
  file: string;
  from: string;
  deleted: boolean;
  binary: boolean;
  added: AddedLine[];
  removed: string[];
};

const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13 };
const NUL = "\0";

function unquoted(name: string): string {
  if (!name.startsWith('"') || !name.endsWith('"')) return name;
  const bytes: number[] = [];
  const body = name.slice(1, -1);
  for (let at = 0; at < body.length; at += 1) {
    const char = body.charAt(at);
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = body.charAt(at + 1);
    const octal = /^[0-7]{3}/.exec(body.slice(at + 1))?.[0];
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      at += octal.length;
    } else {
      bytes.push(ESCAPES[next] ?? next.codePointAt(0) ?? 0);
      at += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function pathOf(header: string, prefix: string): string | undefined {
  const name = unquoted(header.replace(/\t$/, ""));
  if (name === "/dev/null") return undefined;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

function gitHeaderPath(rest: string): string {
  const half = (rest.length - 1) / 2;
  const target = rest.slice(half + 1);
  return target.startsWith("b/") ? target.slice(2) : unquoted(target).replace(/^b\//, "");
}

const fresh = (file: string): FileDiff => ({ file, from: file, deleted: false, binary: false, added: [], removed: [] });

/**
 * Reads the output of git diff (any --unified size, prefixes a/ and b/) into one entry per file, with added lines numbered in the new file.
 */
export function parseDiff(text: string): FileDiff[] {
  const diffs: FileDiff[] = [];
  let current: FileDiff | undefined;
  let line = 0;
  let oldLeft = 0;
  let newLeft = 0;

  for (const raw of text.split("\n")) {
    const row = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (current && (oldLeft > 0 || newLeft > 0)) {
      const content = row.slice(1);
      if (row.startsWith("+")) {
        current.added.push({ line, text: content });
        line += 1;
        newLeft -= 1;
      } else if (row.startsWith("-")) {
        current.removed.push(content);
        oldLeft -= 1;
      } else if (row.startsWith(" ") || row === "") {
        line += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (row.startsWith("diff --git ")) {
      current = fresh(gitHeaderPath(row.slice("diff --git ".length)));
      diffs.push(current);
      continue;
    }
    if (!current) continue;
    const hunk = HUNK.exec(row);
    if (hunk) {
      oldLeft = Number(hunk[1] ?? 1);
      line = Number(hunk[2]);
      newLeft = Number(hunk[3] ?? 1);
      if (newLeft === 0) line += 1;
    } else if (row.startsWith("--- ")) current.from = pathOf(row.slice(4), "a/") ?? current.from;
    else if (row.startsWith("+++ ")) {
      const path = pathOf(row.slice(4), "b/");
      if (path === undefined) current.deleted = true;
      else current.file = path;
    } else if (row.startsWith("rename from ")) current.from = unquoted(row.slice("rename from ".length));
    else if (row.startsWith("rename to ")) current.file = unquoted(row.slice("rename to ".length));
    else if (row.startsWith("deleted file mode")) current.deleted = true;
    else if (row.startsWith("Binary files ") || row === "GIT binary patch") current.binary = true;
  }
  return diffs;
}

/**
 * A file git does not track yet, as a diff that adds every line; undefined for binary content.
 */
export function untrackedDiff(file: string, content: string): FileDiff | undefined {
  if (content.includes(NUL)) return undefined;
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return { ...fresh(file), added: lines.map((text, index) => ({ line: index + 1, text })) };
}

/**
 * The change a diff made to a file whose current content is given: the whole file after, the removed lines before, and exactly the added lines marked. Undefined when the file no longer holds the added lines, as when it changed after the diff was taken.
 */
export function diffChange(diff: FileDiff, content: string, file = diff.file): Change | undefined {
  if (diff.deleted || diff.binary || diff.added.length === 0 || content.includes(NUL)) return undefined;
  const after = content.split(/\r?\n/);
  const added = after.map(() => false);
  for (const { line, text } of diff.added) {
    if (after[line - 1] !== text) return undefined;
    added[line - 1] = true;
  }
  return { file, before: diff.removed, after, added, commit: () => {} };
}
