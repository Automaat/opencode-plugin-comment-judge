import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { format, parseLog, percentile, summarise } from "../scripts/stats.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/stats.ts", import.meta.url));
const HAIKU = "anthropic/claude-haiku-4-5";
const MINI = "openai/gpt-5-mini";

type Verdict = { id: string; action: string; reason: string; rewrite?: string };

function judged(model: string, promptMs: number, cost: number | undefined, verdicts: Verdict[]) {
  return {
    time: "2026-09-15T10:00:00.000Z",
    level: "info",
    message: "judged",
    tool: "edit",
    model,
    promptMs,
    cost,
    structured: true,
    comments: verdicts.map(({ id }) => ({ id, file: "src/a.ts", text: "x" })),
    verdicts,
  };
}

function entry(level: string, message: string, extra: Record<string, unknown> = {}) {
  return { time: "2026-09-15T10:00:00.000Z", level, message, ...extra };
}

const LOG = [
  entry("warn", "model must be provider/model; using small_model"),
  judged(HAIKU, 1000, 0.001, [
    { id: "c1", action: "keep", reason: "explains why" },
    { id: "c2", action: "remove", reason: "restates the code" },
  ]),
  judged(HAIKU, 3000, 0.002, [
    { id: "c1", action: "remove", reason: "restates the code" },
    { id: "c2", action: "rewrite", reason: "task context", rewrite: "short" },
  ]),
  judged(MINI, 2000, undefined, [
    { id: "c1", action: "rewrite", reason: "task context", rewrite: "short" },
    { id: "c2", action: "remove", reason: "restates the code" },
    { id: "c3", action: "keep", reason: "public API" },
  ]),
  entry("info", "comments changed in place", { tool: "edit", changed: [{ id: "c2", action: "remove", from: ["// x"], to: [] }] }),
  entry("info", "edit rejected", { tool: "write", blocks: ["c1"] }),
  entry("info", "same comments re-sent after a rejection; edit written as sent", { tool: "write" }),
  entry("warn", "judge failed; edit written unjudged", { tool: "edit", reason: "judge timed out after 30000ms", ms: 30001 }),
  entry("warn", "judge failed; edit written unjudged", { tool: "edit", reason: "judge timed out after 30000ms", ms: 30002 }),
  entry("warn", "judge failed; edit written unjudged", { tool: "edit", reason: "judge answered without a verdicts list", ms: 900 }),
]
  .map((line) => JSON.stringify(line))
  .concat(["not json {", "[1,2]", '{"level":"info"}', ""])
  .join("\n");

describe("percentile", () => {
  it("has no value for no samples", () => {
    assert.equal(percentile([], 50), null);
  });

  it("uses the nearest rank", () => {
    const hundred = Array.from({ length: 100 }, (_, index) => index + 1);
    assert.equal(percentile(hundred, 50), 50);
    assert.equal(percentile(hundred, 95), 95);
    assert.equal(percentile(hundred, 100), 100);
    assert.equal(percentile([1000, 2000, 3000], 50), 2000);
    assert.equal(percentile([1000, 2000, 3000], 95), 3000);
    assert.equal(percentile([7], 95), 7);
  });

  it("sorts a copy of the samples", () => {
    const samples = [5, 1, 3];
    assert.equal(percentile(samples, 50), 3);
    assert.equal(percentile(samples, 0), 1);
    assert.deepEqual(samples, [5, 1, 3]);
  });
});

describe("parseLog", () => {
  it("counts and skips malformed lines, ignoring blank ones", () => {
    const { entries, malformed } = parseLog(`${LOG}\r\n\n`);
    assert.equal(entries.length, 10);
    assert.equal(malformed, 3);
  });

  it("reads an empty file", () => {
    assert.deepEqual(parseLog(""), { entries: [], malformed: 0 });
  });
});

describe("summarise", () => {
  it("counts every message type", () => {
    const { entries, malformed } = parseLog(LOG);
    assert.deepEqual(summarise(entries, malformed), {
      entries: 10,
      malformed: 3,
      warnings: 1,
      judged: 3,
      blocks: 7,
      verdicts: {
        keep: { count: 2, percent: 28.6 },
        remove: { count: 3, percent: 42.9 },
        rewrite: { count: 2, percent: 28.6 },
      },
      changedInPlace: 1,
      rejected: 1,
      repeats: 1,
      unjudged: 3,
      failures: [
        { value: "judge timed out after 30000ms", count: 2 },
        { value: "judge answered without a verdicts list", count: 1 },
      ],
      latencyMs: { p50: 2000, p95: 3000 },
      cost: 0.003,
      costUnreported: 1,
      models: [
        { value: HAIKU, count: 2 },
        { value: MINI, count: 1 },
      ],
      reasons: {
        keep: [
          { value: "explains why", count: 1 },
          { value: "public API", count: 1 },
        ],
        remove: [{ value: "restates the code", count: 3 }],
        rewrite: [{ value: "task context", count: 2 }],
      },
    });
  });

  it("keeps only the five most common reasons per action", () => {
    const verdicts = ["a", "b", "b", "c", "d", "e", "f"].map((reason, index) => ({ id: `c${index}`, action: "remove", reason }));
    const { entries } = parseLog(JSON.stringify(judged(HAIKU, 1, 0, verdicts)));
    assert.deepEqual(
      summarise(entries, 0).reasons.remove.map(({ value }) => value),
      ["b", "a", "c", "d", "e"],
    );
  });

  it("tolerates entries missing their extras", () => {
    const { entries } = parseLog(['{"message":"judged"}', '{"message":"judge failed; edit written unjudged"}'].join("\n"));
    const summary = summarise(entries, 0);
    assert.equal(summary.judged, 1);
    assert.equal(summary.blocks, 0);
    assert.equal(summary.costUnreported, 1);
    assert.deepEqual(summary.models, []);
    assert.deepEqual(summary.failures, [{ value: "unknown", count: 1 }]);
    assert.deepEqual(summary.latencyMs, { p50: null, p95: null });
  });

  it("summarises an empty log as zeros", () => {
    const summary = summarise([], 0);
    assert.equal(summary.judged, 0);
    assert.deepEqual(summary.verdicts.keep, { count: 0, percent: 0 });
    assert.deepEqual(summary.latencyMs, { p50: null, p95: null });
    assert.equal(summary.cost, 0);
  });
});

describe("format", () => {
  it("aligns every value in one column", () => {
    const { entries, malformed } = parseLog(LOG);
    const text = format(summarise(entries, malformed));
    const rows = text.split("\n\n")[0]?.split("\n") ?? [];
    const columns = new Set(rows.map((row) => /^\S.*?\s{2,}(?=\S)/.exec(row)?.[0].length));
    assert.equal(columns.size, 1);
    assert.match(text, /^judged edits\s+3$/m);
    assert.match(text, /^remove\s+3 \(42\.9%\)$/m);
    assert.match(text, /^judge latency p95\s+3000 ms$/m);
    assert.match(text, /^total cost\s+\$0\.0030 \(1 judged edit without cost\)$/m);
    assert.match(text, /^models\s+anthropic\/claude-haiku-4-5 \(2\), openai\/gpt-5-mini \(1\)$/m);
    assert.match(text, /^written unjudged: top reasons\n {2}2 {2}judge timed out after 30000ms\n {2}1 {2}judge answered without a verdicts list$/m);
    assert.match(text, /^remove: top reasons\n {2}3 {2}restates the code$/m);
  });

  it("shortens long reasons", () => {
    const verdicts = [{ id: "c1", action: "keep", reason: "x".repeat(300) }];
    const { entries } = parseLog(JSON.stringify(judged(HAIKU, 1, 0, verdicts)));
    const line = format(summarise(entries, 0))
      .split("\n")
      .find((row) => row.includes("xxx"));
    assert.ok(line && line.length < 120 && line.endsWith("…"));
  });

  it("prints an empty log without latency or reasons", () => {
    const text = format(summarise([], 0));
    assert.match(text, /^judge latency p50\s+n\/a$/m);
    assert.match(text, /^models\s+none$/m);
    assert.match(text, /^keep: top reasons\n {2}none$/m);
  });
});

describe("cli", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8" });
  const file = join(mkdtempSync(join(tmpdir(), "comment-judge-stats-")), "log.jsonl");
  writeFileSync(file, LOG);

  it("prints the summary as text or JSON", () => {
    const { entries, malformed } = parseLog(LOG);
    const text = run(file);
    assert.equal(text.status, 0);
    assert.equal(text.stdout, `${format(summarise(entries, malformed))}\n`);
    const json = run("--json", file);
    assert.equal(json.status, 0);
    assert.deepEqual(JSON.parse(json.stdout), summarise(entries, malformed));
  });

  it("fails with usage without a path, and with the error for a missing file", () => {
    const bare = run();
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /usage/);
    const missing = run(join(file, "..", "missing.jsonl"));
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /ENOENT/);
  });
});
