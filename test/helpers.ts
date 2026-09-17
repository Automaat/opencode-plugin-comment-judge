import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { blocksOf } from "../src/comments.ts";
import { CommentJudge } from "../src/index.ts";
import type { Block, Change } from "../src/types.ts";

export type Answer = (prompt: string) => unknown;

export type Calls = {
  created: any[];
  prompted: any[];
  aborted: string[];
  deleted: string[];
  logs: any[];
  toasts: any[];
};

export function fakeClient(answer: Answer, smallModel = "cheap/fast") {
  const calls: Calls = { created: [], prompted: [], aborted: [], deleted: [], logs: [], toasts: [] };
  let sessions = 0;
  const client = {
    app: {
      log: async (payload: any) => {
        calls.logs.push(payload.body);
      },
    },
    tui: {
      showToast: async (payload: any) => {
        calls.toasts.push(payload.body);
      },
    },
    config: { get: async () => ({ data: { small_model: smallModel } }) },
    session: {
      create: async (payload: any) => {
        calls.created.push(payload.body);
        sessions += 1;
        return { data: { id: `judge-${sessions}` } };
      },
      prompt: async (payload: any) => {
        calls.prompted.push(payload);
        const structured = await answer(payload.body.parts[0].text);
        return { data: { info: { providerID: "cheap", modelID: "fast", cost: 0, structured }, parts: [] } };
      },
      abort: async (payload: any) => {
        calls.aborted.push(payload.path.id);
      },
      delete: async (payload: any) => {
        calls.deleted.push(payload.path.id);
      },
    },
  };
  return { client, calls };
}

export async function load(answer: Answer, options: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  const { client, calls } = fakeClient(answer);
  const hooks = (await CommentJudge({ client, directory: process.cwd(), ...input } as any, options)) as any;
  return { hooks, calls };
}

export const verdicts = (...list: Record<string, unknown>[]) => ({ verdicts: list });

export async function runEdit(
  hooks: any,
  args: Record<string, unknown>,
  { tool = "edit", sessionID = "session-1", callID = "call-1" } = {},
) {
  const output = { args };
  await hooks["tool.execute.before"]({ tool, sessionID, callID }, output);
  const after = { title: "", output: "Edit applied successfully.", metadata: {} };
  await hooks["tool.execute.after"]({ tool, sessionID, callID, args: output.args }, after);
  return { args: output.args as Record<string, any>, note: after.output };
}

export function changeOf(after: string[], file = "a.ts", before: string[] = []): Change {
  return { file, before, after, commit: () => {} };
}

export function blockOf(raw: string[], file = "a.ts", code = ""): Block {
  return {
    id: "c1",
    change: changeOf(raw, file),
    start: 0,
    raw,
    code,
    text: raw.map((line) => line.trim()).join("\n"),
    context: raw.join("\n"),
  };
}

export type Repository = {
  root: string;
  git: (...args: string[]) => string;
  write: (files: Record<string, string>) => void;
  commit: (message: string) => void;
};

/**
 * A scratch git repository on branch main, isolated from the machine's git configuration.
 */
export function repository(files: Record<string, string> = {}): Repository {
  process.env.GIT_CONFIG_GLOBAL = devNull;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const root = mkdtempSync(join(tmpdir(), "comment-judge-git-"));
  const identity = ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
  const git = (...args: string[]) => execFileSync("git", [...identity, ...args], { cwd: root, encoding: "utf8" });
  const write = (entries: Record<string, string>) => {
    for (const [file, content] of Object.entries(entries)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), content);
    }
  };
  git("init", "-q", "-b", "main");
  write(files);
  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
  };
  commit("base");
  return { root, git, write, commit };
}

export function comments(changes: Change[]): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const block of blocksOf(changes)) found[block.change.file] = [...(found[block.change.file] ?? []), block.raw.join("\n")];
  return found;
}
