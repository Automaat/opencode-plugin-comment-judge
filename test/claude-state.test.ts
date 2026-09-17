import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { prune, sessionState, STATE_TTL_MS } from "../src/claude/state.ts";

const root = () => join(mkdtempSync(join(tmpdir(), "comment-judge-state-")), "state");

describe("sessionState", () => {
  it("hands a note to the next process once, for the same session and tool call only", () => {
    const dir = root();
    sessionState(dir, "session-1").saveNote("toolu_1", "the note");
    assert.equal(sessionState(dir, "session-2").takeNote("toolu_1"), undefined);
    assert.equal(sessionState(dir, "session-1").takeNote("toolu_2"), undefined);
    assert.equal(sessionState(dir, "session-1").takeNote("toolu_1"), "the note");
    assert.equal(sessionState(dir, "session-1").takeNote("toolu_1"), undefined);
  });

  it("remembers rejected fingerprints per session", () => {
    const dir = root();
    sessionState(dir, "session-1").rejections.add("abc");
    assert.equal(sessionState(dir, "session-1").rejections.has("abc"), true);
    assert.equal(sessionState(dir, "session-1").rejections.has("def"), false);
    assert.equal(sessionState(dir, "session-2").rejections.has("abc"), false);
  });

  it("keeps ids out of file names and the files private", { skip: process.platform === "win32" }, () => {
    const dir = root();
    sessionState(dir, "../../escape").saveNote("../toolu", "note");
    const [session] = readdirSync(dir);
    assert.match(session ?? "", /^[0-9a-f]{64}$/);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    const [note] = readdirSync(join(dir, session ?? ""));
    assert.match(note ?? "", /^note-[0-9a-f]{64}$/);
    assert.equal(statSync(join(dir, session ?? "", note ?? "")).mode & 0o777, 0o600);
  });
});

describe("prune", () => {
  it("removes sessions untouched for longer than the TTL", () => {
    const dir = root();
    mkdirSync(join(dir, "old"), { recursive: true });
    mkdirSync(join(dir, "new"));
    const old = new Date(Date.now() - STATE_TTL_MS - 60_000);
    utimesSync(join(dir, "old"), old, old);
    prune(dir);
    assert.deepEqual(readdirSync(dir), ["new"]);
  });

  it("does nothing without a state directory", () => {
    assert.doesNotThrow(() => prune(root()));
  });
});
