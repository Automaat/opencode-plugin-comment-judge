import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Rejections } from "../evaluate.ts";

/**
 * How long a session's notes and rejections outlive its last hook call. Claude Code runs every hook in a new process, so they live in files, and nothing tells the hook a session ended.
 */
export const STATE_TTL_MS = 24 * 60 * 60 * 1000;

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;

const hashed = (value: string) => createHash("sha256").update(value).digest("hex");

export type SessionState = {
  saveNote: (toolUseId: string, note: string) => void;
  takeNote: (toolUseId: string) => string | undefined;
  rejections: Rejections;
};

/**
 * Directory holding the state of every session, private to the user running Claude Code.
 */
export function stateRoot(): string {
  return join(tmpdir(), `comment-judge-claude-${process.getuid?.() ?? "user"}`);
}

/**
 * Removes the state of sessions untouched for longer than STATE_TTL_MS.
 */
export function prune(root: string, now = Date.now()): void {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (now - statSync(path).mtimeMs > STATE_TTL_MS) rmSync(path, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Notes waiting for PostToolUse and rejected comment fingerprints of one session, one file each, so hooks running at the same time never overwrite each other.
 */
export function sessionState(root: string, sessionId: string): SessionState {
  const dir = join(root, hashed(sessionId));
  const file = (kind: string, key: string) => join(dir, `${kind}-${hashed(key)}`);
  const write = (path: string, content: string) => {
    mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR });
    const owner = process.getuid?.();
    if (owner !== undefined && statSync(root).uid !== owner) throw new Error(`${root} belongs to another user`);
    writeFileSync(path, content, { mode: PRIVATE_FILE });
  };

  return {
    saveNote: (toolUseId, note) => write(file("note", toolUseId), note),
    takeNote: (toolUseId) => {
      const path = file("note", toolUseId);
      let note: string | undefined;
      try {
        note = readFileSync(path, "utf8");
        rmSync(path, { force: true });
      } catch {}
      return note;
    },
    rejections: {
      has: (key) => existsSync(file("rejected", key)),
      add: (key) => write(file("rejected", key), ""),
    },
  };
}
