import { basename, extname } from "node:path";

import type { Block, Change, Span, Syntax } from "./types.ts";

export type Marker = "//" | "#" | "--";

type Delimiters = { syntax: Syntax; opener: string; closer: string; end: string; tail: RegExp };

const HASH_EXTENSIONS = new Set([
  ".py", ".rb", ".sh", ".bash", ".zsh", ".fish", ".yaml", ".yml", ".toml", ".nix",
  ".tf", ".hcl", ".pl", ".r", ".ex", ".exs", ".cmake", ".conf", ".ini", ".env",
]);
const HASH_FILES = new Set(["dockerfile", "makefile", "gnumakefile", ".gitignore", ".dockerignore"]);
const DASH_EXTENSIONS = new Set([".sql", ".lua", ".hs", ".elm"]);
const DOCSTRING_EXTENSIONS = new Set([".py"]);
const JSX_EXTENSIONS = new Set([".jsx", ".tsx", ".mdx"]);
const MARKUP_EXTENSIONS = new Set([".html", ".htm", ".md", ".mdx", ".xml", ".vue", ".svelte"]);
const PROSE_EXTENSIONS = new Set([".md", ".mdx"]);
const QUOTES = ['"', "'", "`"];
const CONTEXT_BEFORE = 3;
const CONTEXT_AFTER = 6;
const DOCSTRING_OPENER = /^[rRuU]?(?:"""|''')/;
const DEFINITION = /^(?:async\s+)?(?:def|class)\s/;
const FENCE = /^(?:```|~~~)/;
const JSX: Delimiters = { syntax: "jsx", opener: "{/*", closer: "*/}", end: "*/", tail: /^\s*\}\s*$/ };
const MARKUP: Delimiters = { syntax: "markup", opener: "<!--", closer: "-->", end: "-->", tail: /^\s*$/ };

const extensionOf = (file: string) => extname(basename(file).toLowerCase());
const indentOf = (line: string) => line.length - line.trimStart().length;

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
  if (!trimmed || PROSE_EXTENSIONS.has(extensionOf(file))) return null;
  const marker = markerOf(file);
  if (trimmed.startsWith(marker)) return { code: "", text: trimmed };
  if (marker === "//" && (trimmed.startsWith("/*") || trimmed.startsWith("*"))) return { code: "", text: trimmed };
  const trailing = line.indexOf(` ${marker} `);
  if (trailing > 0 && quotesBalanced(line.slice(0, trailing)))
    return { code: line.slice(0, trailing).trimEnd(), text: line.slice(trailing).trim() };
  return null;
}

function statementAt(lines: string[], from: number): number | undefined {
  for (let index = from; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed && !trimmed.startsWith("#")) return index;
  }
  return undefined;
}

function bracketsOf(line: string): { code: string; depth: number } {
  let quote = "";
  let depth = 0;
  for (let at = 0; at < line.length; at += 1) {
    const char = line.charAt(at);
    if (quote) {
      if (char === "\\") at += 1;
      else if (char === quote) quote = "";
    } else if (char === "#") return { code: line.slice(0, at), depth };
    else if (char === '"' || char === "'") quote = char;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
  }
  return { code: line, depth };
}

function headerEnd(lines: string[], start: number): number | undefined {
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    const scanned = bracketsOf(lines[index] ?? "");
    depth += scanned.depth;
    if (depth > 0) continue;
    return scanned.code.trimEnd().endsWith(":") ? index : undefined;
  }
  return undefined;
}

function docstringEnd(lines: string[], start: number, opener: string): number | undefined {
  const quote = opener.slice(-3);
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (let at = index === start ? line.indexOf(opener) + opener.length : 0; at < line.length; at += 1) {
      if (line.charAt(at) === "\\") at += 1;
      else if (line.startsWith(quote, at)) return line.slice(at + quote.length).trim() ? undefined : index + 1;
    }
  }
  return undefined;
}

function docstringAt(lines: string[], start: number | undefined, owner?: number): Span | undefined {
  if (start === undefined) return undefined;
  const opener = DOCSTRING_OPENER.exec((lines[start] ?? "").trimStart())?.[0];
  const end = opener ? docstringEnd(lines, start, opener) : undefined;
  if (!opener || end === undefined) return undefined;
  const next = statementAt(lines, end);
  const sole = owner !== undefined && (next === undefined || indentOf(lines[next] ?? "") <= owner);
  return { syntax: "docstring", start, end, opener, closer: opener.slice(-3), sole };
}

function docstringSpans(lines: string[]): Span[] {
  const spans: Span[] = [];
  const first = statementAt(lines, 0);
  const module = first !== undefined && indentOf(lines[first] ?? "") === 0 ? docstringAt(lines, first) : undefined;
  if (module) spans.push(module);
  for (const [index, line] of lines.entries()) {
    if (!DEFINITION.test(line.trimStart())) continue;
    const header = headerEnd(lines, index);
    const body = header === undefined ? undefined : statementAt(lines, header + 1);
    if (body === undefined || indentOf(lines[body] ?? "") <= indentOf(line)) continue;
    const span = docstringAt(lines, body, indentOf(line));
    if (span) spans.push(span);
  }
  return spans;
}

function delimitedEnd(lines: string[], start: number, { opener, end, tail }: Delimiters): number | undefined {
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const at = line.indexOf(end, index === start ? line.indexOf(opener) + opener.length : 0);
    if (at >= 0) return tail.test(line.slice(at + end.length)) ? index + 1 : undefined;
  }
  return undefined;
}

function delimitedSpans(lines: string[], delimiters: Delimiters, fenced: boolean): Span[] {
  const spans: Span[] = [];
  let fence = "";
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    const mark = fenced ? FENCE.exec(trimmed)?.[0] : undefined;
    if (mark && (!fence || mark === fence)) fence = fence ? "" : mark;
    if (mark || fence || !trimmed.startsWith(delimiters.opener)) continue;
    const end = delimitedEnd(lines, index, delimiters);
    if (end === undefined) continue;
    spans.push({ syntax: delimiters.syntax, start: index, end, opener: delimiters.opener, closer: delimiters.closer, sole: false });
    index = end - 1;
  }
  return spans;
}

/**
 * Finds the comments that take whole lines and may span several: Python docstrings, JSX comments and markup comments.
 */
export function spansOf(lines: string[], file: string): Span[] {
  const extension = extensionOf(file);
  const fenced = PROSE_EXTENSIONS.has(extension);
  const found = [
    ...(DOCSTRING_EXTENSIONS.has(extension) ? docstringSpans(lines) : []),
    ...(JSX_EXTENSIONS.has(extension) ? delimitedSpans(lines, JSX, fenced) : []),
    ...(MARKUP_EXTENSIONS.has(extension) ? delimitedSpans(lines, MARKUP, fenced) : []),
  ].sort((a, b) => a.start - b.start);
  const spans: Span[] = [];
  for (const span of found) if (span.start >= (spans.at(-1)?.end ?? 0)) spans.push(span);
  return spans;
}

function containsRun(lines: string[], run: string[]): boolean {
  for (let start = 0; start + run.length <= lines.length; start += 1)
    if (run.every((line, offset) => lines[start + offset] === line)) return true;
  return false;
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
    if (block.change.added && containsRun(block.change.before, block.raw)) return;
    blocks.push({
      ...block,
      id: `c${blocks.length + 1}`,
      context: block.change.after.slice(Math.max(0, block.start - CONTEXT_BEFORE), end + CONTEXT_AFTER).join("\n"),
    });
  };

  for (const change of changes) {
    const added = change.added ?? addedLines(change.before, change.after);
    const spans = new Map(spansOf(change.after, change.file).map((span) => [span.start, span]));
    let open: Block | null = null;
    for (let index = 0; index <= change.after.length; index += 1) {
      const span = spans.get(index);
      const line = change.after[index] ?? "";
      const found = !span && index < change.after.length && added[index] ? commentOf(line, change.file) : null;
      if (open && (!found || found.code)) {
        finish(open, index);
        open = null;
      }
      if (span) {
        const raw = change.after.slice(span.start, span.end);
        const text = raw.map((kept) => kept.trim()).join("\n");
        const touched = !change.added || change.added.slice(span.start, span.end).some(Boolean);
        if (touched && !containsRun(change.before, raw)) finish({ id: "", change, start: index, raw, code: "", text, context: "", span }, span.end);
        index = span.end - 1;
        continue;
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
