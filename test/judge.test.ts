import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseVerdicts, render } from "../src/judge.ts";
import { blockOf } from "./helpers.ts";

describe("parseVerdicts", () => {
  it("reads structured output", () => {
    const info = { structured: { verdicts: [{ id: "c1", action: "rewrite", reason: "r", rewrite: "short" }] } };
    assert.deepEqual(parseVerdicts(info, []), [{ id: "c1", action: "rewrite", reason: "r", rewrite: "short" }]);
  });

  it("keeps a comment whose verdict it cannot read", () => {
    const info = { structured: { verdicts: [{ id: "c1", action: "delete-it", reason: "r" }, { id: "c2" }] } };
    assert.deepEqual(
      parseVerdicts(info, []).map(({ action }) => action),
      ["keep", "keep"],
    );
  });

  it("reads a boolean keep", () => {
    const info = { structured: { verdicts: [{ id: "c1", keep: false, reason: "r" }] } };
    assert.equal(parseVerdicts(info, [])[0]?.action, "remove");
  });

  it("falls back to JSON in the text of the answer", () => {
    const parts = [{ type: "text", text: 'Here you go:\n{"verdicts":[{"id":"c1","action":"remove","reason":"r"}]}' }];
    assert.deepEqual(parseVerdicts({}, parts), [{ id: "c1", action: "remove", reason: "r" }]);
  });

  it("refuses an answer without verdicts", () => {
    assert.throws(() => parseVerdicts({}, [{ type: "text", text: "looks fine" }]), /without JSON/);
    assert.throws(() => parseVerdicts({}, [{ type: "text", text: '{"ok":true}' }]), /without a verdicts list/);
  });

  it("refuses an answer the model reported as failed", () => {
    assert.throws(
      () => parseVerdicts({ error: { name: "StructuredOutputError", data: { message: "bad json" } } }, []),
      /StructuredOutputError bad json/,
    );
  });
});

describe("render", () => {
  it("names each comment with its file, text and code", () => {
    const text = render([blockOf(["// why"], "src/a.ts")], "");
    assert.equal(text, "### c1 (src/a.ts)\nComment:\n// why\n\nCode around it, after the edit:\n```\n// why\n```");
  });

  it("puts the task first when there is one", () => {
    assert.match(render([blockOf(["// why"])], "Fix the bug"), /^The task the agent is working on[^\n]*\n<task>\nFix the bug\n<\/task>\n\n### c1/);
  });
});
