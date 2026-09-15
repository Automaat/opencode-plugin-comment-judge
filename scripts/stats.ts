import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import type { Action } from "../src/types.ts";

const ACTIONS: readonly Action[] = ["keep", "remove", "rewrite"];
const TOP = 5;
const REASON_CHARS = 100;
const PERCENT = 100;
const P50 = 50;
const P95 = 95;
const COST_SCALE = 1_000_000;
const COST_DIGITS = 4;
const JSON_INDENT = 2;
const USAGE_EXIT = 2;
const USAGE = "usage: mise run stats -- <log.jsonl> [--json]";

export type Entry = Record<string, unknown> & { message: string };

export type Tally = { value: string; count: number };

export type Summary = {
  entries: number;
  malformed: number;
  warnings: number;
  judged: number;
  blocks: number;
  verdicts: Record<Action, { count: number; percent: number }>;
  changedInPlace: number;
  rejected: number;
  repeats: number;
  unjudged: number;
  failures: Tally[];
  latencyMs: { p50: number | null; p95: number | null };
  cost: number;
  costUnreported: number;
  models: Tally[];
  reasons: Record<Action, Tally[]>;
};

function isEntry(value: unknown): value is Entry {
  return typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { message?: unknown }).message === "string";
}

function isAction(value: unknown): value is Action {
  return ACTIONS.some((action) => action === value);
}

/**
 * Reads a JSON Lines judge log, skipping blank lines and counting lines that are not log entries.
 */
export function parseLog(text: string): { entries: Entry[]; malformed: number } {
  const entries: Entry[] = [];
  let malformed = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {}
    if (isEntry(parsed)) entries.push(parsed);
    else malformed += 1;
  }
  return { entries, malformed };
}

/**
 * Nearest-rank percentile of the samples, or null when there are none.
 */
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = samples.toSorted((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p * sorted.length) / PERCENT));
  return sorted[rank - 1] ?? null;
}

function tally(values: readonly string[], limit: number): Tally[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([value, count]) => ({ value, count }))
    .toSorted((a, b) => b.count - a.count || (a.value < b.value ? -1 : 1))
    .slice(0, limit);
}

function named(value: unknown): string {
  return typeof value === "string" && value ? value : "unknown";
}

/**
 * Counts what the judge did across the entries of a log.
 */
export function summarise(entries: readonly Entry[], malformed: number): Summary {
  const reasons: Record<Action, string[]> = { keep: [], remove: [], rewrite: [] };
  const latencies: number[] = [];
  const models: string[] = [];
  const failures: string[] = [];
  let warnings = 0;
  let judged = 0;
  let blocks = 0;
  let changedInPlace = 0;
  let rejected = 0;
  let repeats = 0;
  let cost = 0;
  let costUnreported = 0;

  for (const entry of entries) {
    switch (entry.message) {
      case "judged": {
        judged += 1;
        if (Array.isArray(entry.comments)) blocks += entry.comments.length;
        if (typeof entry.promptMs === "number") latencies.push(entry.promptMs);
        if (typeof entry.model === "string") models.push(entry.model);
        if (typeof entry.cost === "number") cost += entry.cost;
        else costUnreported += 1;
        for (const verdict of Array.isArray(entry.verdicts) ? entry.verdicts : []) {
          const action: unknown = verdict?.action;
          if (isAction(action)) reasons[action].push(named(verdict.reason));
        }
        break;
      }
      case "comments changed in place": {
        changedInPlace += 1;
        break;
      }
      case "edit rejected": {
        rejected += 1;
        break;
      }
      case "same comments re-sent after a rejection; edit written as sent": {
        repeats += 1;
        break;
      }
      case "judge failed; edit written unjudged": {
        failures.push(named(entry.reason));
        break;
      }
      default: {
        if (entry.level === "warn") warnings += 1;
      }
    }
  }

  const total = ACTIONS.reduce((sum, action) => sum + reasons[action].length, 0);
  const share = (count: number) => (total ? Number(((count / total) * PERCENT).toFixed(1)) : 0);
  const verdict = (action: Action) => ({ count: reasons[action].length, percent: share(reasons[action].length) });

  return {
    entries: entries.length,
    malformed,
    warnings,
    judged,
    blocks,
    verdicts: { keep: verdict("keep"), remove: verdict("remove"), rewrite: verdict("rewrite") },
    changedInPlace,
    rejected,
    repeats,
    unjudged: failures.length,
    failures: tally(failures, TOP),
    latencyMs: { p50: percentile(latencies, P50), p95: percentile(latencies, P95) },
    cost: Math.round(cost * COST_SCALE) / COST_SCALE,
    costUnreported,
    models: tally(models, Infinity),
    reasons: { keep: tally(reasons.keep, TOP), remove: tally(reasons.remove, TOP), rewrite: tally(reasons.rewrite, TOP) },
  };
}

function shorten(value: string): string {
  const flat = value.replaceAll(/\s+/g, " ").trim();
  return flat.length > REASON_CHARS ? `${flat.slice(0, REASON_CHARS - 1)}…` : flat;
}

function section(title: string, tallies: readonly Tally[]): string {
  if (tallies.length === 0) return `${title}\n  none`;
  const width = Math.max(...tallies.map(({ count }) => String(count).length));
  return [title, ...tallies.map(({ value, count }) => `  ${String(count).padStart(width)}  ${shorten(value)}`)].join("\n");
}

/**
 * Renders a summary as aligned plain text.
 */
export function format(summary: Summary): string {
  const ms = (value: number | null) => (value === null ? "n/a" : `${value} ms`);
  const unreported = summary.costUnreported === 1 ? " (1 judged edit without cost)" : ` (${summary.costUnreported} judged edits without cost)`;
  const rows: [string, string][] = [
    ["log lines", `${summary.entries} read, ${summary.malformed} malformed`],
    ["option warnings", String(summary.warnings)],
    ["judged edits", String(summary.judged)],
    ["comment blocks", String(summary.blocks)],
    ...ACTIONS.map((action): [string, string] => {
      const { count, percent } = summary.verdicts[action];
      return [action, `${count} (${percent.toFixed(1)}%)`];
    }),
    ["changed in place", String(summary.changedInPlace)],
    ["rejected", String(summary.rejected)],
    ["repeats written as sent", String(summary.repeats)],
    ["written unjudged", String(summary.unjudged)],
    ["judge latency p50", ms(summary.latencyMs.p50)],
    ["judge latency p95", ms(summary.latencyMs.p95)],
    ["total cost", `$${summary.cost.toFixed(COST_DIGITS)}${summary.costUnreported ? unreported : ""}`],
    ["models", summary.models.length ? summary.models.map(({ value, count }) => `${value} (${count})`).join(", ") : "none"],
  ];
  const width = Math.max(...rows.map(([label]) => label.length)) + 2;
  const table = rows.map(([label, value]) => `${label.padEnd(width)}${value}`).join("\n");
  return [
    table,
    section("written unjudged: top reasons", summary.failures),
    ...ACTIONS.map((action) => section(`${action}: top reasons`, summary.reasons[action])),
  ].join("\n\n");
}

function main(): void {
  let json: boolean | undefined;
  let positionals: string[];
  try {
    ({
      values: { json },
      positionals,
    } = parseArgs({ options: { json: { type: "boolean" } }, allowPositionals: true }));
  } catch {
    positionals = [];
  }
  const [path] = positionals;
  if (!path || positionals.length > 1) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = USAGE_EXIT;
    return;
  }
  let content: string;
  try {
    content = readFileSync(resolve(process.env.MISE_ORIGINAL_CWD ?? "", path), "utf8");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const { entries, malformed } = parseLog(content);
  const summary = summarise(entries, malformed);
  process.stdout.write(`${json ? JSON.stringify(summary, null, JSON_INDENT) : format(summary)}\n`);
}

if (import.meta.main) main();
