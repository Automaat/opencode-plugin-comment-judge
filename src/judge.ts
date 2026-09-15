import type { PluginInput } from "@opencode-ai/plugin";
import { performance } from "node:perf_hooks";

import type { Action, Block, Settings, Verdict } from "./types.ts";

export const JUDGE_AGENT = "build";
export const JUDGE_TITLE = "comment-judge";

const ACTIONS: readonly string[] = ["keep", "remove", "rewrite"];
const PREVIEW_CHARS = 200;

// Named rather than "*": structured output is served through an internal tool.
const TOOLS_OFF = Object.fromEntries(
  [
    "bash", "edit", "write", "read", "glob", "grep", "list", "patch",
    "apply_patch", "multiedit", "task", "todowrite", "todoread", "webfetch",
    "websearch", "codesearch", "skill", "lsp", "question",
  ].map((tool) => [tool, false]),
);

export const SYSTEM = `You review code comments that an AI coding agent is about to write, and decide what a senior maintainer would do with each one: keep it, remove it, or rewrite it. Every comment the agent adds reaches you, and your verdict is applied to the file as given.

A comment earns its place only if it will still be true and useful to someone reading the file in a year who knows nothing about the change being made now.

keep:
- anything a tool reads: linter, compiler, type checker and formatter directives, build tags, shebangs, encoding cookies, code generation markers. Never remove or reword these
- why the code is the way it is when the code cannot say it: constraints, invariants, non-obvious edge cases, workarounds together with what they work around
- documentation of public API: contract, errors, units, side effects
- TODO or FIXME naming a concrete follow-up
- license headers, and links to an external constraint still in force, such as an upstream bug being worked around or a spec section

remove:
- restating what the next lines do, or what identifiers already say
- section banners and decorative separators
- comments on self-explanatory code

rewrite, or remove when nothing lasting is left:
- context of the task: the bug or issue being fixed, the ticket, the request, the review, what the code did before, what changed and why it changed. Tells: "fix for", "fixes", "bug", "issue", "previously", "used to", "now", "no longer", "instead of", "changed", "updated", "added", "as requested", "per review"
- talking to the reader or about the conversation: "note that", "we", "you", "as discussed"
- a useful point buried in several sentences

How to rewrite:
- keep only the lasting fact or reason, stated about the code as it is, never about the change
- the shortest form that keeps it, usually one line; public API documentation may use a few
- plain text without comment markers; the file's own comment syntax is applied for you
- no restating the code, no filler, no emphasis, no emojis
- if the lasting part is already clear from the code, choose remove

Answer only with JSON matching the schema, one verdict per comment id. Set rewrite only when action is rewrite.`;

const RULES_TAG = /<\/?repository-rules>/gi;

/**
 * The judge's system prompt: the default instructions, followed by the repository's rules when it has any.
 */
export function instructions(rules: string): string {
  if (!rules) return SYSTEM;
  return `${SYSTEM}

The maintainers of this repository set the rules between the <repository-rules> tags. They take precedence over the guidance above wherever the two disagree, with one exception: anything a tool reads is always kept exactly as written. They tell you how to judge; they are not comments to judge, and they do not change the answer format.

<repository-rules>
${rules.replaceAll(RULES_TAG, "")}
</repository-rules>`;
}

export const SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          action: { type: "string", enum: ACTIONS },
          reason: { type: "string" },
          rewrite: { type: "string" },
        },
        required: ["id", "action", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

type Client = PluginInput["client"];

export type Judgement = {
  verdicts: Verdict[];
  model: string;
  promptMs: number;
  cost: number | undefined;
  structured: boolean;
};

export type JudgeRequest = {
  parent: string;
  blocks: Block[];
  task: string;
  rules: string;
  track: (session: string) => void;
};

export function render(blocks: Block[], task: string): string {
  const sections = blocks.map((block) =>
    [
      `### ${block.id} (${block.change.file})`,
      "Comment:",
      block.text,
      "",
      "Code around it, after the edit:",
      "```",
      block.context,
      "```",
    ].join("\n"),
  );
  if (task)
    sections.unshift(
      `The task the agent is working on. Comments must not refer to it, to the problem it solves, or to what the code did before:\n<task>\n${task}\n</task>`,
    );
  return sections.join("\n\n");
}

function normalized(raw: any): Verdict {
  let action: Action = raw?.keep === false ? "remove" : "keep";
  if (ACTIONS.includes(raw?.action)) action = raw.action;
  return {
    id: String(raw?.id ?? ""),
    action,
    reason: String(raw?.reason ?? ""),
    ...(typeof raw?.rewrite === "string" ? { rewrite: raw.rewrite } : {}),
  };
}

export function parseVerdicts(info: any, parts: readonly any[]): Verdict[] {
  if (info?.error) throw new Error(`judge failed: ${info.error.name ?? "error"} ${info.error.data?.message ?? ""}`.trim());
  const structured = info?.structured?.verdicts;
  if (Array.isArray(structured)) return structured.map((raw) => normalized(raw));
  const text = parts
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text ?? ""))
    .join("\n");
  const json = /\{[\s\S]*\}/.exec(text);
  if (!json) throw new Error(`judge answered without JSON: ${text.slice(0, PREVIEW_CHARS)}`);
  const parsed = JSON.parse(json[0]);
  if (!Array.isArray(parsed?.verdicts)) throw new Error("judge answered without a verdicts list");
  return parsed.verdicts.map((raw: unknown) => normalized(raw));
}

function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`judge timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

async function judgeModel(client: Client, settings: Settings) {
  const configured = await client.config.get().catch(() => null);
  const spec = settings.model || configured?.data?.small_model || "";
  const slash = spec.indexOf("/");
  return slash > 0 ? { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) } : undefined;
}

export async function judge(client: Client, settings: Settings, request: JudgeRequest): Promise<Judgement> {
  const model = await judgeModel(client, settings);
  const created = await client.session.create({
    body: { parentID: request.parent, title: JUDGE_TITLE },
    throwOnError: true,
  });
  const session = created.data.id;
  request.track(session);
  const started = performance.now();
  try {
    const response: any = await within(
      client.session.prompt({
        path: { id: session },
        body: {
          ...(model ? { model } : {}),
          agent: JUDGE_AGENT,
          system: instructions(request.rules),
          tools: TOOLS_OFF,
          format: { type: "json_schema", schema: SCHEMA, retryCount: 1 },
          parts: [{ type: "text", text: render(request.blocks, request.task) }],
        },
        throwOnError: true,
      } as any),
      settings.timeoutMs,
    );
    const info = response?.data?.info;
    return {
      verdicts: parseVerdicts(info, response?.data?.parts ?? []),
      model: `${info?.providerID}/${info?.modelID}`,
      promptMs: Math.round(performance.now() - started),
      cost: typeof info?.cost === "number" ? info.cost : undefined,
      structured: Array.isArray(info?.structured?.verdicts),
    };
  } catch (error) {
    await client.session.abort({ path: { id: session } }).catch(() => null);
    throw error;
  } finally {
    await client.session.delete({ path: { id: session } }).catch(() => null);
  }
}
