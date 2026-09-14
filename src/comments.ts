import { basename, extname } from "node:path";

import type { Block, Change } from "./types.ts";

export type Marker = "//" | "#" | "--";

const HASH_EXTENSIONS = new Set([
  ".py", ".rb", ".sh", ".bash", ".zsh", ".fish", ".yaml", ".yml", ".toml", ".nix",
  ".tf", ".hcl", ".pl", ".r", ".ex", ".exs", ".cmake", ".conf", ".ini", ".env",
]);
const HASH_FILES = new Set(["dockerfile", "makefile", "gnumakefile", ".gitignore", ".dockerignore"]);
const DASH_EXTENSIONS = new Set([".sql", ".lua", ".hs", ".elm"]);
const QUOTES = ['"', "'", "`"];
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 6;

export function markerOf(file: string): Marker {
  const name = basename(file).toLowerCase();
  const extension = extname(name);
  if (HASH_EXTENSIONS.has(extension) || HASH_FILES.has(name)) return "#";
  if (DASH_EXTENSIONS.has(extension)) return "--";
  return "//";
}

function quotesBalanced(text: string): boolean {
  return QUOTES.every((quote) => text.split(quote).length % 2 === 1);
}

export function commentOf(line: string, file: string): { code: string; text: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const marker = markerOf(file);
  if (trimmed.startsWith(marker)) return { code: "", text: trimmed };
  if (marker === "//" && (trimmed.startsWith("/*") || trimmed.startsWith("*"))) return { code: "", text: trimmed };
  const trailing = line.indexOf(` ${marker} `);
  if (trailing > 0 && quotesBalanced(line.slice(0, trailing)))
    return { code: line.slice(0, trailing).trimEnd(), text: line.slice(trailing).trim() };
  return null;
}

export function addedLines(before: string[], after: string[]): boolean[] {
  const pool = new Map<string, number>();
  for (const line of before) pool.set(line, (pool.get(line) ?? 0) + 1);
  return after.map((line) => {
    const left = pool.get(line) ?? 0;
    if (left === 0) return true;
    pool.set(line, left - 1);
    return false;
  });
}

export function blocksOf(changes: Change[]): Block[] {
  const blocks: Block[] = [];
  const finish = (block: Block, end: number) => {
    blocks.push({
      ...block,
      id: `c${blocks.length + 1}`,
      context: block.change.after.slice(Math.max(0, block.start - CONTEXT_BEFORE), end + CONTEXT_AFTER).join("\n"),
    });
  };

  for (const change of changes) {
    const added = addedLines(change.before, change.after);
    let open: Block | null = null;
    for (let index = 0; index <= change.after.length; index += 1) {
      const line = change.after[index] ?? "";
      const found = index < change.after.length && added[index] ? commentOf(line, change.file) : null;
      if (open && (!found || found.code)) {
        finish(open, index);
        open = null;
      }
      if (!found) continue;
      if (open) {
        open.raw.push(line);
        open.text = `${open.text}\n${found.text}`;
        continue;
      }
      const block: Block = { id: "", change, start: index, raw: [line], code: found.code, text: found.text, context: "" };
      if (found.code) finish(block, index + 1);
      else open = block;
    }
  }
  return blocks;
}
