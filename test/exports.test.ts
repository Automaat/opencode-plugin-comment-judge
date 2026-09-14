import assert from "node:assert/strict";
import { it } from "node:test";

it("exports the plugin and nothing else, because opencode calls every export as a plugin", async () => {
  const module = await import("../src/index.ts");
  assert.deepEqual(Object.keys(module), ["CommentJudge"]);
  assert.equal(typeof module.CommentJudge, "function");
});
