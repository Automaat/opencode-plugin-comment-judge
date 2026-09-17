import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { z } from "zod";

import { BATCH_SIZE, batches, COMMAND_NAME, report, TOOL_NAME } from "../src/branch.ts";
import { RULES_FILE } from "../src/rules.ts";
import { blockOf, changeOf, load, repository, runEdit, verdicts, type Answer } from "./helpers.ts";

const CART = "export function total(items: number[]): number {\n  return items.length;\n}\n";
const BASE = { commit: "0123456789abcdef", label: "merge base of HEAD and main" };

function context(directory: string, abort = new AbortController().signal) {
  const titles: string[] = [];
  return {
    titles,
    sessionID: "session-1",
    messageID: "message-1",
    agent: "build",
    directory,
    worktree: directory,
    abort,
    metadata: (input: { title?: string }) => {
      if (input.title) titles.push(input.title);
    },
    ask: async () => {},
  };
}

function branch(files: Record<string, string>) {
  const repo = repository({ "src/cart.ts": CART });
  repo.git("checkout", "-q", "-b", "feature");
  repo.write(files);
  repo.commit("feature");
  return repo;
}

const ids = (prompt: string) => [...prompt.matchAll(/^### (c\d+) /gm)].map((match) => match[1]);

async function judgeBranch(answer: Answer, files: Record<string, string>, options: Record<string, unknown> = {}) {
  const repo = branch(files);
  const { hooks, calls } = await load(answer, options, { directory: repo.root, worktree: repo.root });
  const ctx = context(repo.root);
  return { repo, hooks, calls, ctx, run: (args: Record<string, unknown> = {}) => hooks.tool[TOOL_NAME].execute(args, ctx) };
}

describe("batches", () => {
  it("splits comments into calls of at most BATCH_SIZE", () => {
    const items = Array.from({ length: BATCH_SIZE * 2 + 5 }, (_, index) => index);
    assert.deepEqual(
      batches(items).map((batch) => batch.length),
      [BATCH_SIZE, BATCH_SIZE, 5],
    );
    assert.deepEqual(batches([]), []);
  });
});

describe("report", () => {
  it("says so when the branch adds no comments", () => {
    assert.equal(
      report({ base: BASE, files: 3, blocks: [], flags: [], failures: [] }),
      "judge_comments: no comments added since 0123456789ab (merge base of HEAD and main) in 3 changed file(s).",
    );
  });

  it("lists each comment to change per file with its line, first line, replacement and reason, and only counts kept ones", () => {
    const cart = changeOf(["x();", "  // Loop over the items", "  // one by one", "  items.forEach(add);", "  // Fix: ABC-1 made two lines", "  y();"], "src/cart.ts");
    const loop = { ...blockOf(cart.after.slice(1, 3), "src/cart.ts"), id: "c1", change: cart, start: 1 };
    const story = { ...blockOf(cart.after.slice(4, 5), "src/cart.ts"), id: "c2", change: cart, start: 4 };
    const kept = { ...blockOf(["# why"], "a.py"), id: "c3" };
    const vague = { ...blockOf(["// long story"], "src/b.ts"), id: "c4" };
    const text = report({
      base: BASE,
      files: 2,
      blocks: [loop, story, kept, vague],
      flags: [
        { block: loop, verdict: { id: "c1", action: "remove", reason: "restates the loop" }, lines: [] },
        { block: story, verdict: { id: "c2", action: "rewrite", reason: "narrates the fix" }, lines: ["  // SKUs compare case-insensitively."] },
        { block: vague, verdict: { id: "c4", action: "rewrite", reason: "too long" } },
      ],
      failures: [],
    });
    assert.equal(
      text,
      [
        "judge_comments: 4 comment block(s) added since 0123456789ab (merge base of HEAD and main): 1 keep, 1 remove, 2 rewrite.",
        "Suggested lines are in the file's comment syntax and indentation. Apply them with edits that change only these lines.",
        "",
        "## src/cart.ts",
        "",
        "src/cart.ts:2 remove",
        "current: // Loop over the items",
        "reason: restates the loop",
        "delete lines 2-3",
        "",
        "src/cart.ts:5 rewrite",
        "current: // Fix: ABC-1 made two lines",
        "reason: narrates the fix",
        "replace line 5 with:",
        "```",
        "  // SKUs compare case-insensitively.",
        "```",
        "",
        "## src/b.ts",
        "",
        "src/b.ts:1 rewrite",
        "current: // long story",
        "reason: too long",
        "change by hand: no rewrite was given, so keep only the lasting reason in line 1, or delete it",
      ].join("\n"),
    );
  });

  it("names the comments it could not judge and why", () => {
    const block = blockOf(["// why"], "src/a.ts");
    const text = report({ base: BASE, files: 1, blocks: [block], flags: [], failures: [{ blocks: [block], reason: "judge timed out after 10ms" }] });
    assert.match(text, /^judge_comments: 1 comment block\(s\) added since 0123456789ab \(merge base of HEAD and main\): 0 keep, 0 remove, 0 rewrite, 1 not judged\./);
    assert.match(text, /\nnot judged \(judge timed out after 10ms\): src\/a\.ts:1$/);
  });
});

describe("/judge-comments command", () => {
  it("is added to the config and asks the agent to run the tool with the user's arguments and apply what it returns", async () => {
    const { hooks } = await load(() => verdicts());
    const config: Record<string, any> = {};
    await hooks.config(config);
    const command = config.command[COMMAND_NAME];
    assert.match(command.template, new RegExp(TOOL_NAME));
    assert.match(command.template, /\$ARGUMENTS/);
    assert.match(command.template, /code/);
    assert.ok(command.description);
  });

  it("leaves a command the user defined with that name alone", async () => {
    const { hooks } = await load(() => verdicts());
    const mine = { template: "my own review" };
    const config = { command: { [COMMAND_NAME]: mine, other: { template: "x" } } };
    await hooks.config(config);
    assert.deepEqual(config.command, { [COMMAND_NAME]: mine, other: { template: "x" } });
  });
});

describe("judge_comments tool", () => {
  it("takes an optional base and optional paths", async () => {
    const { hooks } = await load(() => verdicts());
    const { args, description } = hooks.tool[TOOL_NAME];
    const schema = z.object(args);
    assert.ok(schema.safeParse({}).success);
    assert.ok(schema.safeParse({ base: "main", paths: ["src"] }).success);
    assert.equal(schema.safeParse({ paths: "src" }).success, false);
    assert.equal((z.toJSONSchema(schema) as { required?: string[] }).required, undefined);
    assert.match(description, /does not edit files/i);
  });

  it("judges the comments the branch adds under the calling session and reports what to change", async () => {
    const { run, calls, ctx } = await judgeBranch(
      () => verdicts({ id: "c1", action: "rewrite", reason: "narrates the fix", rewrite: "Counts lines, not quantities." }),
      { "src/cart.ts": CART.replace("  return", "  // Fix: previously counted quantities\n  return") },
    );
    const text = await run();
    assert.equal(calls.created.length, 1);
    assert.equal(calls.created[0].parentID, "session-1");
    assert.match(calls.prompted[0].body.parts[0].text, /### c1 \(src\/cart\.ts\)\nComment:\n\/\/ Fix: previously counted quantities/);
    assert.match(text, /^judge_comments: 1 comment block\(s\) added since [0-9a-f]{12} \(merge base of HEAD and main\): 0 keep, 0 remove, 1 rewrite\./);
    assert.match(text, /src\/cart\.ts:2 rewrite\ncurrent: \/\/ Fix: previously counted quantities\nreason: narrates the fix\nreplace line 2 with:\n```\n {2}\/\/ Counts lines, not quantities\.\n```/);
    assert.match(ctx.titles.join("\n"), /^1 comment\(s\) since [0-9a-f]{12}$/);
    assert.deepEqual(calls.deleted, ["judge-1"]);
  });

  it("is not offered to the judge, and refuses to run inside a judge session", async () => {
    const { run, hooks, calls, repo } = await judgeBranch(
      () => verdicts({ id: "c1", action: "keep", reason: "fine" }),
      { "src/a.ts": "// note\n" },
    );
    await run();
    assert.equal(calls.prompted[0].body.tools[TOOL_NAME], false);
    await assert.rejects(hooks.tool[TOOL_NAME].execute({}, { ...context(repo.root), sessionID: "judge-1" }), /not available to the comment judge/);
    assert.equal(calls.created.length, 1);
  });

  it("says when there is nothing to judge, without asking the model", async () => {
    const { run, calls } = await judgeBranch(() => verdicts(), { "src/cart.ts": CART.replace("items.length", "items.length + 0") });
    assert.match(await run(), /^judge_comments: no comments added since [0-9a-f]{12} \(merge base of HEAD and main\) in 1 changed file\(s\)\.$/);
    assert.equal(calls.created.length, 0);
  });

  it("judges many comments in bounded batches with the repository rules", async () => {
    const files = Object.fromEntries(Array.from({ length: BATCH_SIZE + 3 }, (_, index) => [`src/f${String(index).padStart(2, "0")}.ts`, `// note ${index}\nexport const v${index} = ${index};\n`]));
    const { repo, run, calls } = await judgeBranch((prompt) => verdicts(...ids(prompt).map((id) => ({ id, action: "keep", reason: "fine" }))), files);
    writeFileSync(join(repo.root, RULES_FILE), "- Keep every note.");
    const text = await run({ paths: ["src"] });
    assert.deepEqual(
      calls.prompted.map(({ body }) => ids(body.parts[0].text).length),
      [BATCH_SIZE, 3],
    );
    assert.ok(calls.prompted.every(({ body }) => /Keep every note/.test(body.system)));
    assert.match(text, new RegExp(`: ${BATCH_SIZE + 3} keep, 0 remove, 0 rewrite\\.`));
  });

  it("reports comments whose judge call failed or ran past timeoutMs, and still reports the rest", async () => {
    const files = Object.fromEntries(Array.from({ length: BATCH_SIZE + 1 }, (_, index) => [`src/f${String(index).padStart(2, "0")}.ts`, `// note ${index}\n`]));
    const { run, calls } = await judgeBranch(
      (prompt) => (ids(prompt).length === 1 ? new Promise(() => {}) : verdicts({ id: "c1", action: "remove", reason: "noise" })),
      files,
      { timeoutMs: 50 },
    );
    const text = await run();
    assert.match(text, /: 19 keep, 1 remove, 0 rewrite, 1 not judged\./);
    assert.match(text, /\nnot judged \(judge timed out after 50ms\): src\/f20\.ts:1$/);
    assert.ok(calls.logs.some((entry) => entry.level === "warn" && /timed out/.test(entry.extra?.reason)));
  });

  it("fails with git's reason when the base cannot be used", async () => {
    const { run, calls } = await judgeBranch(() => verdicts(), {});
    await assert.rejects(run({ base: "no-such-branch" }), /is not a commit/);
    assert.ok(calls.logs.some((entry) => entry.level === "warn" && /is not a commit/.test(entry.extra?.reason)));
  });

  it("stops when the call is aborted", async () => {
    const { hooks, repo, calls } = await judgeBranch(() => verdicts(), { "src/a.ts": "// note\n" });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(hooks.tool[TOOL_NAME].execute({}, context(repo.root, controller.signal)), /abort/i);
    assert.equal(calls.created.length, 0);
  });
});

describe("applying judge_comments suggestions", () => {
  const STORY = "  // Fix: previously counted quantities";
  const REWRITE = "  // Counts lines, not quantities.";

  async function suggested() {
    const setup = await judgeBranch(
      () => verdicts({ id: "c1", action: "rewrite", reason: "narrates the fix", rewrite: "Counts lines, not quantities." }),
      { "src/cart.ts": CART.replace("  return", `${STORY}\n  return`) },
    );
    await setup.run();
    return setup;
  }

  it("does not judge again an edit that writes a suggested comment as given", async () => {
    const { hooks, calls } = await suggested();
    const { args } = await runEdit(hooks, { filePath: "src/cart.ts", oldString: STORY, newString: REWRITE }, { callID: "apply-1" });
    assert.equal(args.newString, REWRITE);
    assert.equal(calls.created.length, 1);
    assert.ok(calls.logs.some((entry) => /suggested/.test(entry.message)));
  });

  it("still judges other comments in the same edit, and edits in other sessions", async () => {
    const { hooks, calls } = await suggested();
    await runEdit(hooks, { filePath: "src/cart.ts", oldString: STORY, newString: `${REWRITE}\n  x();\n  // Another note` }, { callID: "apply-2" });
    assert.equal(calls.created.length, 2);
    assert.deepEqual(ids(calls.prompted[1].body.parts[0].text), ["c2"]);
    await runEdit(hooks, { filePath: "src/cart.ts", oldString: STORY, newString: REWRITE }, { sessionID: "session-2", callID: "apply-3" });
    assert.equal(calls.created.length, 3);
  });
});
