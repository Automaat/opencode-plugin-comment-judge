export type Op = { start: number; length: number; lines: string[] };

export type Change = {
  file: string;
  before: string[];
  after: string[];
  /**
   * Which lines of after are new, when known exactly, as from a diff; otherwise lines of after missing from before count as new.
   */
  added?: boolean[];
  commit: (ops: Op[]) => void;
};

export type Syntax = "docstring" | "jsx" | "markup";

export type Span = { syntax: Syntax; start: number; end: number; opener: string; closer: string; sole: boolean };

export type Block = {
  id: string;
  change: Change;
  start: number;
  raw: string[];
  code: string;
  text: string;
  context: string;
  span?: Span;
};

export type Action = "keep" | "remove" | "rewrite";

export type Verdict = { id: string; action: Action; reason: string; rewrite?: string };

export type Flag = { block: Block; verdict: Verdict; lines?: string[] };

export type Settings = { model: string; timeoutMs: number; log: string };
