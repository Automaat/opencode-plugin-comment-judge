import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { blockFor, CASES_DIR, failureKind, format, loadCases, outcomeOf, parseCase, parseOptions, score, type Outcome } from "../scripts/eval.ts";
import { render } from "../src/judge.ts";

const SCRIPT = fileURLToPath(new URL("../scripts/eval.ts", import.meta.url));
const HAIKU = "gateway/claude-haiku-4-5";
const GLM = "gateway/glm-flash";

const valid = {
  file: "src/retry.ts",
  comment: "// Full jitter spreads retries of clients that failed together.",
  context: "export function delay(attempt: number) {\n  // Full jitter spreads retries of clients that failed together.\n  return Math.random() * 2 ** attempt;\n}",
  expected: "keep",
  why: "Explains why the delay is random.",
};

function outcome(model: string, name: string, expected: string, extra: Partial<Outcome> = {}): Outcome {
  return { model, case: name, run: 1, expected: expected as Outcome["expected"], ...extra };
}

describe("parseOptions", () => {
  it("reads repeated models and cases, runs and json", () => {
    assert.deepEqual(parseOptions(["--model", HAIKU, "--model", GLM, "--case", "a", "--case", "b", "--runs", "3", "--json"]), {
      models: [HAIKU, GLM],
      cases: ["a", "b"],
      runs: 3,
      json: true,
    });
  });

  it("defaults to every case, one run and text output", () => {
    assert.deepEqual(parseOptions(["--model", HAIKU]), { models: [HAIKU], cases: [], runs: 1, json: false });
  });

  it("drops a repeated model", () => {
    assert.deepEqual(parseOptions(["--model", HAIKU, "--model", HAIKU]).models, [HAIKU]);
  });

  it("refuses missing or malformed models, bad runs, unknown flags and positionals", () => {
    for (const args of [
      [],
      ["--model", "haiku"],
      ["--model", "gateway/"],
      ["--model", HAIKU, "--runs", "0"],
      ["--model", HAIKU, "--runs", "1.5"],
      ["--model", HAIKU, "--runs", "two"],
      ["--model", HAIKU, "--verbose"],
      ["--model", HAIKU, "extra"],
    ])
      assert.throws(() => parseOptions(args), /usage|model|runs|Unknown|positional/i, args.join(" "));
  });
});

describe("parseCase", () => {
  it("reads a case with optional task and rules defaulting to empty", () => {
    assert.deepEqual(parseCase("keep-jitter", valid), { name: "keep-jitter", task: "", rules: "", ...valid });
    const full = parseCase("x", { ...valid, task: "Add retries", rules: "- Keep everything." });
    assert.equal(full.task, "Add retries");
    assert.equal(full.rules, "- Keep everything.");
  });

  it("names every problem with a case", () => {
    const cases: [unknown, RegExp][] = [
      [null, /x: must be a JSON object/],
      [[], /x: must be a JSON object/],
      [{ ...valid, file: "noextension" }, /x: file/],
      [{ ...valid, comment: "" }, /x: comment/],
      [{ ...valid, context: 3 }, /x: context/],
      [{ ...valid, expected: "delete" }, /x: expected/],
      [{ ...valid, why: "" }, /x: why/],
      [{ ...valid, why: "two\nlines" }, /x: why/],
      [{ ...valid, task: 1 }, /x: task/],
      [{ ...valid, rules: false }, /x: rules/],
      [{ ...valid, reason: "typo of why" }, /x: unknown field reason/],
      [{ ...valid, context: "export const a = 1;" }, /x: comment is not found as an added comment in context/],
      [{ ...valid, comment: "// Full jitter" }, /x: comment is not found/],
    ];
    for (const [value, error] of cases) assert.throws(() => parseCase("x", value), error, JSON.stringify(value));
  });
});

describe("blockFor", () => {
  it("builds the block the plugin would send for the case's comment", () => {
    const block = blockFor(parseCase("x", valid));
    assert.equal(block.id, "c1");
    assert.equal(block.change.file, "src/retry.ts");
    assert.deepEqual(block.change.after, valid.context.split("\n"));
    assert.deepEqual(block.raw, ["  // Full jitter spreads retries of clients that failed together."]);
    assert.equal(block.text, valid.comment);
    assert.equal(block.context, valid.context);
    assert.equal(render([block], ""), `### c1 (src/retry.ts)\nComment:\n${valid.comment}\n\nCode around it, after the edit:\n\`\`\`\n${valid.context}\n\`\`\``);
  });

  it("picks the case's comment when the context has others, and reads docstrings", () => {
    const context = 'def f():\n    """Return one."""\n    # the answer\n    return 1';
    assert.equal(blockFor(parseCase("x", { ...valid, file: "a.py", comment: "# the answer", context })).text, "# the answer");
    const docstring = blockFor(parseCase("x", { ...valid, file: "a.py", comment: '"""Return one."""', context }));
    assert.equal(docstring.span?.syntax, "docstring");
    assert.deepEqual(docstring.raw, ['    """Return one."""']);
  });
});

describe("seed cases", () => {
  const cases = loadCases(CASES_DIR, []);

  it("are all valid", () => {
    assert.ok(cases.length >= 24, `${cases.length} cases`);
  });

  it("cover every action, the required languages and repository rules", () => {
    for (const action of ["keep", "remove", "rewrite"]) assert.ok(cases.some(({ expected }) => expected === action), action);
    const extensions = new Set(cases.map(({ file }) => extname(file)));
    for (const extension of [".ts", ".py", ".go", ".tsx", ".md", ".sh"]) assert.ok(extensions.has(extension), extension);
    assert.ok(cases.some(({ file, comment }) => file.endsWith(".py") && comment.startsWith('"""')));
    assert.ok(cases.filter(({ rules }) => rules).length >= 2);
  });
});

describe("loadCases", () => {
  const dir = mkdtempSync(join(tmpdir(), "comment-judge-eval-"));
  writeFileSync(join(dir, "b.json"), JSON.stringify(valid));
  writeFileSync(join(dir, "a.json"), JSON.stringify({ ...valid, expected: "remove" }));
  writeFileSync(join(dir, "notes.txt"), "ignored");

  it("reads every case sorted by name, or the named ones", () => {
    assert.deepEqual(
      loadCases(dir, []).map(({ name }) => name),
      ["a", "b"],
    );
    assert.deepEqual(
      loadCases(dir, ["b"]).map(({ name }) => name),
      ["b"],
    );
  });

  it("refuses an unknown case name and a file that is not JSON", () => {
    assert.throws(() => loadCases(dir, ["missing"]), /unknown case missing/);
    const broken = mkdtempSync(join(tmpdir(), "comment-judge-eval-"));
    writeFileSync(join(broken, "bad.json"), "{");
    assert.throws(() => loadCases(broken, []), /bad: /);
  });
});

describe("outcomeOf", () => {
  const entry = parseCase("x", valid);

  it("records the verdict, latency and cost of a judgement", () => {
    const judgement = { verdicts: [{ id: "c1", action: "remove" as const, reason: "restates" }], model: HAIKU, promptMs: 1200, cost: 0.001, structured: true };
    assert.deepEqual(outcomeOf(HAIKU, entry, 2, judgement), {
      model: HAIKU,
      case: "x",
      run: 2,
      expected: "keep",
      verdict: { id: "c1", action: "remove", reason: "restates" },
      ms: 1200,
      cost: 0.001,
    });
  });

  it("records an error, or a judgement without a verdict for the comment", () => {
    assert.deepEqual(outcomeOf(HAIKU, entry, 1, new Error("judge timed out after 30000ms")), {
      model: HAIKU,
      case: "x",
      run: 1,
      expected: "keep",
      error: "judge timed out after 30000ms",
    });
    const empty = { verdicts: [], model: HAIKU, promptMs: 5, cost: undefined, structured: true };
    assert.equal(outcomeOf(HAIKU, entry, 1, empty).error, "judge answered without a verdict for c1");
  });
});

describe("failureKind", () => {
  it("tells timeouts and unreadable answers from other errors", () => {
    assert.equal(failureKind("judge timed out after 30000ms"), "timeout");
    assert.equal(failureKind("judge answered without JSON: hi"), "bad JSON");
    assert.equal(failureKind("judge answered without a verdicts list"), "bad JSON");
    assert.equal(failureKind("judge answered without a verdict for c1"), "bad JSON");
    assert.equal(failureKind("judge failed: StructuredOutputError bad"), "bad JSON");
    assert.equal(failureKind("Unexpected token } in JSON at position 3"), "bad JSON");
    assert.equal(failureKind("judge failed: ProviderAuthError 401"), "error");
  });
});

const OUTCOMES: Outcome[] = [
  outcome(HAIKU, "k1", "keep", { verdict: { id: "c1", action: "keep", reason: "why" }, ms: 1000, cost: 0.001 }),
  outcome(HAIKU, "r1", "remove", { verdict: { id: "c1", action: "keep", reason: "explains intent" }, ms: 3000, cost: 0.002 }),
  outcome(HAIKU, "w1", "rewrite", { verdict: { id: "c1", action: "rewrite", reason: "story", rewrite: "short" }, ms: 2000, cost: 0.001 }),
  outcome(HAIKU, "w1", "rewrite", { run: 2, error: "judge timed out after 30000ms" }),
  outcome(GLM, "k1", "keep", { verdict: { id: "c1", action: "remove", reason: "restates", rewrite: "" }, ms: 500 }),
  outcome(GLM, "r1", "remove", { error: "judge answered without JSON: sure" }),
];

describe("score", () => {
  it("counts agreement per model and per expected action, over every run", () => {
    const [haiku, glm] = score(OUTCOMES, [HAIKU, GLM]);
    assert.deepEqual(haiku, {
      model: HAIKU,
      cases: 3,
      runs: 4,
      agreement: { agreed: 2, total: 4, percent: 50 },
      actions: {
        keep: { agreed: 1, total: 1, percent: 100 },
        remove: { agreed: 0, total: 1, percent: 0 },
        rewrite: { agreed: 1, total: 2, percent: 50 },
      },
      latencyMs: { p50: 2000, p95: 3000 },
      cost: 0.004,
      costUnreported: 0,
      failures: { timeout: 1, "bad JSON": 0, error: 0 },
      failed: [{ case: "w1", run: 2, kind: "timeout", error: "judge timed out after 30000ms" }],
      disagreements: [{ case: "r1", run: 1, expected: "remove", got: "keep", reason: "explains intent" }],
    });
    assert.equal(glm?.agreement.percent, 0);
    assert.equal(glm?.costUnreported, 1);
    assert.deepEqual(glm?.failures, { timeout: 0, "bad JSON": 1, error: 0 });
    assert.deepEqual(glm?.disagreements, [{ case: "k1", run: 1, expected: "keep", got: "remove", reason: "restates", rewrite: "" }]);
  });

  it("reports a model without outcomes as empty", () => {
    const [report] = score([], [HAIKU]);
    assert.deepEqual(report?.agreement, { agreed: 0, total: 0, percent: 0 });
    assert.deepEqual(report?.latencyMs, { p50: null, p95: null });
  });
});

describe("format", () => {
  it("prints one table row per model, then the disagreements and failures", () => {
    const text = format(score(OUTCOMES, [HAIKU, GLM]));
    assert.match(text, /^\| model \| cases \| runs \| agreement \| keep \| remove \| rewrite \| p50 \| p95 \| cost \| failures \|$/m);
    assert.match(text, /^\| gateway\/claude-haiku-4-5 \| 3 \| 4 \| 2\/4 \(50\.0%\) \| 1\/1 \| 0\/1 \| 1\/2 \| 2000 ms \| 3000 ms \| \$0\.0040 \| 1 timeout \|$/m);
    assert.match(text, /^\| gateway\/glm-flash \| 2 \| 2 \| 0\/2 \(0\.0%\) \| 0\/1 \| 0\/1 \| 0\/0 \| 500 ms \| 500 ms \| n\/a \| 1 bad JSON \|$/m);
    assert.match(text, /^gateway\/claude-haiku-4-5 disagreements\n- r1 \(run 1\): expected remove, got keep: explains intent$/m);
    assert.match(text, /^gateway\/claude-haiku-4-5 failures\n- w1 \(run 2\): timeout: judge timed out after 30000ms$/m);
    assert.match(text, /^gateway\/glm-flash disagreements\n- k1: expected keep, got remove: restates$/m);
  });

  it("says when a model agreed on everything", () => {
    const text = format(score([OUTCOMES[0] as Outcome], [HAIKU]));
    assert.match(text, /^gateway\/claude-haiku-4-5 disagreements\n- none$/m);
    assert.doesNotMatch(text, /failures\n/);
  });
});

describe("cli", () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  it("fails with usage before starting opencode", () => {
    for (const args of [[], ["--model", "nope"], ["--model", HAIKU, "--case", "no-such-case"]]) {
      const result = run(...args);
      assert.equal(result.status, 2, args.join(" "));
      assert.match(result.stderr, /usage/);
    }
  });
});
