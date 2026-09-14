import { markerOf } from "./comments.ts";
import type { Block, Change, Flag, Op } from "./types.ts";

const LEADING_MARKER = /^(?:\/{2,}|#+|-{2,}|\/\*+|\*+)\s*/;
const BLOCK_CLOSE = /\*\//g;

function cleaned(rewrite: string): string[] {
  return rewrite
    .split(/\r?\n/)
    .map((line) => line.trim().replace(LEADING_MARKER, "").replace(BLOCK_CLOSE, "* /").trim())
    .filter(Boolean);
}

export function formatted(block: Block, rewrite: string): string[] {
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
  if (block.code) return true;
  const head = (block.raw[0] ?? "").trim();
  const opens = head.startsWith("/*");
  const closes = (block.raw.at(-1) ?? "").trim().endsWith("*/");
  return opens === closes || (head.startsWith("*") && closes);
}

export function replacement({ block, verdict }: Flag): string[] | undefined {
  if (!replaceableInPlace(block)) return undefined;
  if (verdict.action === "remove") return formatted(block, "");
  if (verdict.action === "rewrite" && verdict.rewrite?.trim()) return formatted(block, verdict.rewrite);
  return undefined;
}

export function applyInPlace(flags: Flag[]): void {
  const ops = new Map<Change, Op[]>();
  for (const { block, lines } of flags) {
    if (!lines) continue;
    ops.set(block.change, [...(ops.get(block.change) ?? []), { start: block.start, length: block.raw.length, lines }]);
  }
  for (const [change, list] of ops) change.commit(list);
}
