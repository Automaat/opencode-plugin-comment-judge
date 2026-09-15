import { extname } from "node:path";

import { markerOf } from "./comments.ts";
import type { Block, Change, Flag, Op, Span, Syntax } from "./types.ts";

const LEADING_MARKER = /^(?:\/{2,}|#+|-{2,}|\/\*+|\*+)\s*/;
const BLOCK_CLOSE = /\*\//g;
const DELIMITERS: Record<Syntax, RegExp> = {
  docstring: /^[rRuU]?(?:"""|''')|(?:"""|''')$/g,
  jsx: /^\{?\/\*|\*\/\}?$/g,
  markup: /^<!--|-->$/g,
};

function cleaned(rewrite: string): string[] {
  return rewrite
    .split(/\r?\n/)
    .map((line) => line.trim().replace(LEADING_MARKER, "").replace(BLOCK_CLOSE, "* /").trim())
    .filter(Boolean);
}

function escaped(span: Span, file: string, line: string): string {
  if (span.syntax === "jsx") return line.replaceAll(BLOCK_CLOSE, "* /");
  if (span.syntax === "markup")
    return extname(file).toLowerCase() === ".xml" ? line.replaceAll(/-(?=-)/g, "- ") : line.replaceAll(/--(!?)>/g, "--$1 >");
  const quote = span.closer.charAt(0);
  const text = /^[rR]/.test(span.opener) ? line : line.replaceAll("\\", "\\\\");
  return text.replaceAll(new RegExp(`${quote}(?=${quote}${quote})`, "g"), `${quote} `);
}

function spanned(block: Block, span: Span, rewrite: string): string[] {
  const text = rewrite
    .split(/\r?\n/)
    .map((line) => escaped(span, block.change.file, line.trim().replaceAll(DELIMITERS[span.syntax], "").trim()))
    .filter(Boolean);
  const [first = "", ...rest] = text;
  if (text.length === 0) return [];

  const indent = /^\s*/.exec(block.raw[0] ?? "")?.[0] ?? "";
  const { opener, closer } = span;
  if (span.syntax !== "docstring") {
    if (text.length === 1) return [`${indent}${opener} ${first} ${closer}`];
    return [`${indent}${opener}`, ...text.map((line) => `${indent}  ${line}`), `${indent}${closer}`];
  }
  if (text.length === 1) {
    const joins = first.endsWith(closer.charAt(0)) || first.endsWith("\\");
    return [`${indent}${opener}${first}${joins ? " " : ""}${closer}`];
  }
  return [`${indent}${opener}${first}`, ...rest.map((line) => `${indent}${line}`), `${indent}${closer}`];
}

export function formatted(block: Block, rewrite: string): string[] {
  if (block.span) return spanned(block, block.span, rewrite);
  const marker = markerOf(block.change.file);
  const text = cleaned(rewrite);
  if (block.code) return text.length > 0 ? [`${block.code} ${marker} ${text.join(" ")}`] : [block.code];
  if (text.length === 0) return [];

  const first = block.raw[0] ?? "";
  const indent = /^\s*/.exec(first)?.[0] ?? "";
  const head = first.trim();
  const opener = head.startsWith("/**") ? "/**" : head.startsWith("/*") ? "/*" : "";
  if (opener && text.length === 1) return [`${indent}${opener} ${text[0]} */`];
  if (opener) return [`${indent}${opener}`, ...text.map((line) => `${indent} * ${line}`), `${indent} */`];
  if (head.startsWith("*")) {
    const closes = (block.raw.at(-1) ?? "").trim().endsWith("*/");
    return [...text.map((line) => `${indent}* ${line}`), ...(closes ? [`${indent}*/`] : [])];
  }
  return text.map((line) => `${indent}${marker} ${line}`);
}

export function replaceableInPlace(block: Block): boolean {
  if (block.code || block.span) return true;
  const head = (block.raw[0] ?? "").trim();
  const opens = head.startsWith("/*");
  const closes = (block.raw.at(-1) ?? "").trim().endsWith("*/");
  return opens === closes || (head.startsWith("*") && closes);
}

export function replacement({ block, verdict }: Flag): string[] | undefined {
  if (!replaceableInPlace(block)) return undefined;
  let lines: string[] | undefined;
  if (verdict.action === "remove") lines = formatted(block, "");
  else if (verdict.action === "rewrite" && verdict.rewrite?.trim()) lines = formatted(block, verdict.rewrite);
  const leavesBodyEmpty = lines?.length === 0 && block.span?.sole;
  return leavesBodyEmpty ? undefined : lines;
}

export function applyInPlace(flags: Flag[]): void {
  const ops = new Map<Change, Op[]>();
  for (const { block, lines } of flags) {
    if (!lines) continue;
    ops.set(block.change, [...(ops.get(block.change) ?? []), { start: block.start, length: block.raw.length, lines }]);
  }
  for (const [change, list] of ops) change.commit(list);
}
