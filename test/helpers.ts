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

export async function load(answer: Answer, options: Record<string, unknown> = {}) {
  const { client, calls } = fakeClient(answer);
  const hooks = (await CommentJudge({ client, directory: process.cwd() } as any, options)) as any;
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
