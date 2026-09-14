export type Op = { start: number; length: number; lines: string[] };

export type Change = {
  file: string;
  before: string[];
  after: string[];
  commit: (ops: Op[]) => void;
};

export type Block = {
  id: string;
  change: Change;
  start: number;
  raw: string[];
  code: string;
  text: string;
  context: string;
};

export type Action = "keep" | "remove" | "rewrite";

export type Verdict = { id: string; action: Action; reason: string; rewrite?: string };

export type Flag = { block: Block; verdict: Verdict; lines?: string[] };

export type Settings = { model: string; timeoutMs: number; log: string };
