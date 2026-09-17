import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";

import { blocksOf } from "../src/comments.ts";
import { judge, type Judgement } from "../src/judge.ts";
import { DEFAULT_TIMEOUT_MS } from "../src/options.ts";
import type { Action, Block, Verdict } from "../src/types.ts";
import { percentile } from "./stats.ts";

const ACTIONS: readonly Action[] = ["keep", "remove", "rewrite"];
const FIELDS = new Set(["file", "comment", "context", "task", "rules", "expected", "why"]);
const MODEL_SPEC = /^[^/\s]+\/\S+$/;
const RUNS = /^[1-9]\d*$/;
const BLOCK_ID = "c1";
const PERCENT = 100;
const P50 = 50;
const P95 = 95;
const COST_SCALE = 1_000_000;
const COST_DIGITS = 4;
const JSON_INDENT = 2;
const USAGE_EXIT = 2;
const START_TIMEOUT_MS = 60_000;
const SIGNAL_EXIT: Record<string, number> = { SIGINT: 130, SIGTERM: 143 };
const USAGE = "usage: mise run eval -- --model provider/model [--model ...] [--case name] [--runs n] [--json]";

/**
 * Directory holding one JSON file per eval case.
 */
export const CASES_DIR = resolve(import.meta.dirname, "../eval/cases");

export type Options = { models: string[]; cases: string[]; runs: number; json: boolean };

export type Case = {
  name: string;
  file: string;
  comment: string;
  context: string;
  task: string;
  rules: string;
  expected: Action;
  why: string;
};

export type Outcome = {
  model: string;
  case: string;
  run: number;
  expected: Action;
  verdict?: Verdict;
  ms?: number;
  cost?: number;
  error?: string;
};

export type FailureKind = "timeout" | "bad JSON" | "error";

export type Rate = { agreed: number; total: number; percent: number };

export type Report = {
  model: string;
  cases: number;
  runs: number;
  agreement: Rate;
  actions: Record<Action, Rate>;
  latencyMs: { p50: number | null; p95: number | null };
  cost: number;
  costUnreported: number;
  failures: Record<FailureKind, number>;
  failed: { case: string; run: number; kind: FailureKind; error: string }[];
  disagreements: { case: string; run: number; expected: Action; got: Action; reason: string; rewrite?: string }[];
};

/**
 * Reads the command line, throwing on anything the eval cannot run with.
 */
export function parseOptions(args: string[]): Options {
  const { values, positionals } = parseArgs({
    args,
    options: {
      model: { type: "string", multiple: true },
      case: { type: "string", multiple: true },
      runs: { type: "string" },
      json: { type: "boolean" },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 0) throw new Error(`unexpected positional argument ${positionals[0]}`);
  const models = [...new Set(values.model ?? [])];
  if (models.length === 0) throw new Error("at least one --model is required");
  const malformed = models.find((model) => !MODEL_SPEC.test(model));
  if (malformed !== undefined) throw new Error(`model must be "provider/model", got ${JSON.stringify(malformed)}`);
  const runs = values.runs ?? "1";
  if (!RUNS.test(runs)) throw new Error(`runs must be a positive integer, got ${JSON.stringify(runs)}`);
  return { models, cases: [...new Set(values.case ?? [])], runs: Number(runs), json: values.json ?? false };
}

function isAction(value: unknown): value is Action {
  return ACTIONS.some((action) => action === value);
}

function optionalText(name: string, field: string, value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error(`${name}: ${field} must be a string`);
  return value;
}

function requiredText(name: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name}: ${field} must be a non-empty string`);
  return value;
}

/**
 * The block the plugin would send for a case: its comment as blocksOf finds it in the context, which is sent whole.
 */
export function blockFor(entry: Case): Block {
  const change = { file: entry.file, before: [], after: entry.context.split("\n"), commit: () => {} };
  const text = entry.comment
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
  const block = blocksOf([change]).find((found) => found.text === text);
  if (!block) throw new Error(`${entry.name}: comment is not found as an added comment in context`);
  return { ...block, id: BLOCK_ID, context: entry.context };
}

/**
 * Validates one parsed case file, naming the case and the first problem found.
 */
export function parseCase(name: string, value: unknown): Case {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name}: must be a JSON object`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).find((key) => !FIELDS.has(key));
  if (unknown !== undefined) throw new Error(`${name}: unknown field ${unknown}`);
  const file = requiredText(name, "file", raw.file);
  if (!extname(file)) throw new Error(`${name}: file must be a path with an extension`);
  const comment = requiredText(name, "comment", raw.comment);
  const context = requiredText(name, "context", raw.context);
  const task = optionalText(name, "task", raw.task);
  const rules = optionalText(name, "rules", raw.rules);
  if (!isAction(raw.expected)) throw new Error(`${name}: expected must be one of ${ACTIONS.join(", ")}`);
  const why = requiredText(name, "why", raw.why);
  if (why.includes("\n")) throw new Error(`${name}: why must be one line`);
  const entry: Case = { name, file, comment, context, task, rules, expected: raw.expected, why };
  blockFor(entry);
  return entry;
}

/**
 * Loads and validates the cases in dir sorted by name, or only the named ones.
 */
export function loadCases(dir: string, names: readonly string[]): Case[] {
  const available = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .toSorted();
  const missing = names.find((name) => !available.includes(name));
  if (missing !== undefined) throw new Error(`unknown case ${missing}`);
  const chosen = names.length > 0 ? available.filter((name) => names.includes(name)) : available;
  return chosen.map((name) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    return parseCase(name, parsed);
  });
}

/**
 * What one judge call on a case came to: the verdict for its comment, or the error.
 */
export function outcomeOf(model: string, entry: Case, run: number, result: Judgement | unknown): Outcome {
  const base = { model, case: entry.name, run, expected: entry.expected };
  if (result instanceof Error) return { ...base, error: result.message };
  const judgement = result as Judgement;
  if (!Array.isArray(judgement?.verdicts)) return { ...base, error: String(result) };
  const verdict = judgement.verdicts.find(({ id }) => id === BLOCK_ID);
  if (!verdict) return { ...base, error: `judge answered without a verdict for ${BLOCK_ID}` };
  return { ...base, verdict, ms: judgement.promptMs, ...(typeof judgement.cost === "number" ? { cost: judgement.cost } : {}) };
}

/**
 * Sorts a judge error into a timeout, an answer that could not be read, or anything else.
 */
export function failureKind(error: string): FailureKind {
  if (/timed out/i.test(error)) return "timeout";
  if (/JSON|verdict|StructuredOutput/i.test(error)) return "bad JSON";
  return "error";
}

function rate(agreed: number, total: number): Rate {
  return { agreed, total, percent: total ? Number(((agreed / total) * PERCENT).toFixed(1)) : 0 };
}

/**
 * Scores the outcomes of each model against the expected actions; a failed run counts as not agreeing.
 */
export function score(outcomes: readonly Outcome[], models: readonly string[]): Report[] {
  return models.map((model) => {
    const mine = outcomes.filter((outcome) => outcome.model === model);
    const agrees = (outcome: Outcome) => outcome.verdict?.action === outcome.expected;
    const judged = mine.filter((outcome) => outcome.verdict);
    const failed = mine.flatMap(({ case: name, run, error }) => (error === undefined ? [] : [{ case: name, run, kind: failureKind(error), error }]));
    const failures: Record<FailureKind, number> = { timeout: 0, "bad JSON": 0, error: 0 };
    for (const { kind } of failed) failures[kind] += 1;
    const actionRate = (action: Action) => {
      const expected = mine.filter((outcome) => outcome.expected === action);
      return rate(expected.filter((outcome) => agrees(outcome)).length, expected.length);
    };
    return {
      model,
      cases: new Set(mine.map((outcome) => outcome.case)).size,
      runs: mine.length,
      agreement: rate(mine.filter((outcome) => agrees(outcome)).length, mine.length),
      actions: { keep: actionRate("keep"), remove: actionRate("remove"), rewrite: actionRate("rewrite") },
      latencyMs: {
        p50: percentile(judged.map(({ ms }) => ms ?? 0), P50),
        p95: percentile(judged.map(({ ms }) => ms ?? 0), P95),
      },
      cost: Math.round(judged.reduce((sum, { cost }) => sum + (cost ?? 0), 0) * COST_SCALE) / COST_SCALE,
      costUnreported: judged.filter(({ cost }) => cost === undefined).length,
      failures,
      failed,
      disagreements: judged
        .filter((outcome) => !agrees(outcome))
        .map(({ case: name, run, expected, verdict }) => ({
          case: name,
          run,
          expected,
          got: verdict?.action ?? "keep",
          reason: verdict?.reason ?? "",
          ...(verdict?.rewrite === undefined ? {} : { rewrite: verdict.rewrite }),
        })),
    };
  });
}

function costText(report: Report): string {
  const judged = report.runs - report.failed.length;
  if (judged === 0 || report.costUnreported === judged) return "n/a";
  const dollars = `$${report.cost.toFixed(COST_DIGITS)}`;
  return report.costUnreported ? `${dollars} (${report.costUnreported} without cost)` : dollars;
}

function failuresText(report: Report): string {
  const kinds = Object.entries(report.failures).filter(([, count]) => count > 0);
  return kinds.length ? kinds.map(([kind, count]) => `${count} ${kind}`).join(", ") : "none";
}

/**
 * Renders the reports as a Markdown table, followed by each model's disagreements and failures.
 */
export function format(reports: readonly Report[]): string {
  const ms = (value: number | null) => (value === null ? "n/a" : `${value} ms`);
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const header = ["model", "cases", "runs", "agreement", "keep", "remove", "rewrite", "p50", "p95", "cost", "failures"];
  const table = [
    row(header),
    row(header.map(() => "---")),
    ...reports.map((report) =>
      row([
        report.model,
        String(report.cases),
        String(report.runs),
        `${report.agreement.agreed}/${report.agreement.total} (${report.agreement.percent.toFixed(1)}%)`,
        ...ACTIONS.map((action) => `${report.actions[action].agreed}/${report.actions[action].total}`),
        ms(report.latencyMs.p50),
        ms(report.latencyMs.p95),
        costText(report),
        failuresText(report),
      ]),
    ),
  ].join("\n");
  const sections = reports.flatMap((report) => {
    const label = (name: string, run: number) => (report.runs > report.cases ? `${name} (run ${run})` : name);
    const flat = (text: string) => text.replaceAll(/\s+/g, " ").trim();
    const disagreements = report.disagreements.map(
      ({ case: name, run, expected, got, reason }) => `- ${label(name, run)}: expected ${expected}, got ${got}: ${flat(reason)}`,
    );
    const lines = [`${report.model} disagreements\n${disagreements.length ? disagreements.join("\n") : "- none"}`];
    if (report.failed.length)
      lines.push(`${report.model} failures\n${report.failed.map(({ case: name, run, kind, error }) => `- ${label(name, run)}: ${kind}: ${flat(error)}`).join("\n")}`);
    return lines;
  });
  return [table, ...sections].join("\n\n");
}

async function unknownModels(client: OpencodeClient, models: readonly string[]): Promise<string[]> {
  const listed = await client.config.providers().catch(() => null);
  const providers = listed?.data?.providers;
  if (!providers) return [];
  const known = new Set(providers.flatMap((provider) => Object.keys(provider.models).map((model) => `${provider.id}/${model}`)));
  return models.filter((model) => !known.has(model));
}

async function judgeOnce(client: OpencodeClient, model: string, entry: Case): Promise<unknown> {
  let parent: string | undefined;
  try {
    const created = await client.session.create({ body: { title: "comment-judge eval" }, throwOnError: true });
    parent = created.data.id;
    const request = { parent, blocks: [blockFor(entry)], task: entry.task, rules: entry.rules, track: () => {} };
    return await judge(client, { model, timeoutMs: DEFAULT_TIMEOUT_MS, log: "" }, request);
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  } finally {
    if (parent) await client.session.delete({ path: { id: parent } }).catch(() => null);
  }
}

async function replay(client: OpencodeClient, options: Options, cases: readonly Case[]): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (const model of options.models) {
    for (const entry of cases) {
      for (let run = 1; run <= options.runs; run += 1) {
        const outcome = outcomeOf(model, entry, run, await judgeOnce(client, model, entry));
        outcomes.push(outcome);
        const got = outcome.verdict ? `${outcome.verdict.action} in ${outcome.ms} ms` : `failed: ${outcome.error}`;
        const mark = outcome.verdict?.action === entry.expected ? "ok  " : "MISS";
        process.stderr.write(`${mark} ${model} ${entry.name} run ${run}/${options.runs}: expected ${entry.expected}, ${got}\n`);
      }
    }
  }
  return outcomes;
}

async function main(): Promise<void> {
  let options: Options;
  let cases: Case[];
  try {
    options = parseOptions(process.argv.slice(2));
    cases = loadCases(CASES_DIR, options.cases);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}\n`);
    process.exitCode = USAGE_EXIT;
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "comment-judge-eval-"));
  const controller = new AbortController();
  let server: { url: string; close(): void } | undefined;
  const cleanup = () => {
    server?.close();
    rmSync(directory, { recursive: true, force: true });
  };
  const interrupt = (signal: NodeJS.Signals) => {
    controller.abort();
    cleanup();
    process.exit(SIGNAL_EXIT[signal] ?? 1);
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    try {
      server = await createOpencodeServer({ port: 0, timeout: START_TIMEOUT_MS, signal: controller.signal });
    } catch (error) {
      process.stderr.write(`cannot start opencode: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
      return;
    }
    const client = createOpencodeClient({ baseUrl: server.url, directory });
    const unknown = await unknownModels(client, options.models);
    if (unknown.length > 0) {
      process.stderr.write(`unknown model ${unknown.join(", ")}; list the available ones with: opencode models </dev/null\n${USAGE}\n`);
      process.exitCode = USAGE_EXIT;
      return;
    }
    const outcomes = await replay(client, options, cases);
    const reports = score(outcomes, options.models);
    process.stdout.write(`${options.json ? JSON.stringify({ reports, outcomes }, null, JSON_INDENT) : format(reports)}\n`);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    cleanup();
  }
}

if (import.meta.main) await main();
