import type { Config, Hooks, PluginInput, ToolContext } from "@opencode-ai/plugin";
import { z } from "zod";

import { blocksOf } from "./comments.ts";
import { flagged } from "./flags.ts";
import { branchChanges, type Base } from "./git.ts";
import { judge } from "./judge.ts";
import { replaceableInPlace } from "./rewrite.ts";
import type { Log } from "./rules.ts";
import type { Block, Flag, Settings } from "./types.ts";

export const TOOL_NAME = "judge_comments";
export const COMMAND_NAME = "judge-comments";

/**
 * Most comments sent to the judge in one call, so a long branch cannot outgrow the prompt or timeoutMs.
 */
export const BATCH_SIZE = 20;

const PARALLEL_CALLS = 3;
const SHORT_SHA = 12;
const FIRST_LINE_CHARS = 100;

export const TOOL_DESCRIPTION = `Judge the comments this git branch adds. Every comment in the diff between the base and the working tree, including uncommitted and untracked files, is judged keep, remove or rewrite, the same way comments are judged as they are written. Returns each comment to remove or rewrite with its file, line, the replacement lines in the file's own comment syntax, and the reason; kept comments are only counted. Does not edit files: apply the suggestions with edits.`;

export const COMMAND_TEMPLATE = `Review the comments this branch adds and fix the ones that do not earn their place.

1. Call the ${TOOL_NAME} tool. The user's arguments, if any: "$ARGUMENTS". A git ref among them is \`base\`; file or directory paths go in \`paths\`. Pass nothing the user did not give.
2. For each comment it reports, edit the file: replace the listed lines with the suggested lines exactly as given, or delete them when it says delete. Where it says to change a comment by hand, make the smallest edit that follows its reason.
3. Change only those comment lines. Leave all code, other comments and formatting untouched, and do not run ${TOOL_NAME} again.
4. Finish with a short list of the comments you changed.`;

export type Failure = { blocks: Block[]; reason: string };

export type Report = { base: Base; files: number; blocks: Block[]; flags: Flag[]; failures: Failure[] };

export type BranchJudgeInput = {
  client: PluginInput["client"];
  settings: Settings;
  rules: () => string;
  track: (session: string) => void;
  isJudge: (session: string) => boolean;
  log: Log;
  directory: string;
};

type Args = { base?: string | undefined; paths?: string[] | undefined };

export function batches<T>(items: T[], size = BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += size) result.push(items.slice(start, start + size));
  return result;
}

const lineOf = (block: Block) => block.start + 1;

const lineRange = (block: Block) =>
  block.raw.length > 1 ? `lines ${lineOf(block)}-${lineOf(block) + block.raw.length - 1}` : `line ${lineOf(block)}`;

const location = (block: Block) => `${block.change.file}:${lineOf(block)}`;

function byHand({ block, verdict }: Flag): string {
  if (!replaceableInPlace(block))
    return `change by hand: the comment continues past ${lineRange(block)}, so keep only the lasting reason in the whole comment, or delete it`;
  if (verdict.action === "remove")
    return `change by hand: the docstring in ${lineRange(block)} is the whole body of its definition, so replace it with a statement or rewrite it`;
  return `change by hand: no rewrite was given, so keep only the lasting reason in ${lineRange(block)}, or delete it`;
}

function suggestion(flag: Flag): string[] {
  const { block, verdict, lines } = flag;
  const head = [`${location(block)} ${verdict.action}`, `current: ${(block.raw[0] ?? "").trim().slice(0, FIRST_LINE_CHARS)}`, `reason: ${verdict.reason}`];
  if (!lines) return [...head, byHand(flag)];
  if (lines.length === 0) return [...head, `delete ${lineRange(block)}`];
  return [...head, `replace ${lineRange(block)} with:`, "```", ...lines, "```"];
}

/**
 * The tool's answer to the agent: counts, then every comment to remove or rewrite grouped by file, then the comments that could not be judged.
 */
export function report({ base, files, blocks, flags, failures }: Report): string {
  const since = `since ${base.commit.slice(0, SHORT_SHA)} (${base.label})`;
  if (blocks.length === 0) return `${TOOL_NAME}: no comments added ${since} in ${files} changed file(s).`;

  const unjudged = failures.reduce((sum, failure) => sum + failure.blocks.length, 0);
  const count = (action: string) => flags.filter(({ verdict }) => verdict.action === action).length;
  const counts = [
    `${blocks.length - flags.length - unjudged} keep`,
    `${count("remove")} remove`,
    `${count("rewrite")} rewrite`,
    ...(unjudged > 0 ? [`${unjudged} not judged`] : []),
  ];
  const lines = [`${TOOL_NAME}: ${blocks.length} comment block(s) added ${since}: ${counts.join(", ")}.`];

  if (flags.length > 0) {
    lines.push("Suggested lines are in the file's comment syntax and indentation. Apply them with edits that change only these lines.");
    const byFile = new Map<string, Flag[]>();
    for (const flag of flags) byFile.set(flag.block.change.file, [...(byFile.get(flag.block.change.file) ?? []), flag]);
    for (const [file, fileFlags] of byFile) {
      lines.push("", `## ${file}`);
      for (const flag of fileFlags) lines.push("", ...suggestion(flag));
    }
  }
  for (const failure of failures) lines.push("", `not judged (${failure.reason}): ${failure.blocks.map((block) => location(block)).join(", ")}`);
  return lines.join("\n");
}

async function inParallel<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (let index = next; index < items.length; index = next) {
      next += 1;
      await work(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const keyOf = (lines: string[]) => lines.map((line) => line.trim()).join("\n");

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * The judge_comments tool, the /judge-comments command, and the filter that keeps the edit hook from judging again the comments the tool suggested.
 */
export function branchJudge({ client, settings, rules, track, isJudge, log, directory }: BranchJudgeInput) {
  const suggested = new Map<string, Set<string>>();

  const run = async (args: Args, context: ToolContext): Promise<string> => {
    if (isJudge(context.sessionID)) throw new Error(`${TOOL_NAME} is not available to the comment judge`);
    const started = Date.now();
    const found = await branchChanges({
      cwd: context.directory || directory,
      ...(args.base ? { base: args.base } : {}),
      ...(args.paths ? { paths: args.paths } : {}),
      signal: context.abort,
    }).catch((error: unknown) => {
      log("warn", "branch comments cannot be read", { reason: messageOf(error) });
      throw error;
    });
    const blocks = blocksOf(found.changes);
    log("info", "judging branch comments", { base: found.base.commit, label: found.base.label, files: found.files, comments: blocks.length });
    context.metadata({ title: `${blocks.length} comment(s) since ${found.base.commit.slice(0, SHORT_SHA)}` });

    const parts = batches(blocks);
    const flags: Flag[][] = parts.map(() => []);
    const failures: Failure[] = [];
    await inParallel(parts, PARALLEL_CALLS, async (batch, index) => {
      if (context.abort.aborted) return;
      try {
        const judgement = await judge(client, settings, { parent: context.sessionID, blocks: batch, task: "", rules: rules(), track });
        flags[index] = flagged(batch, judgement.verdicts);
        log("info", "branch comments judged", {
          model: judgement.model,
          promptMs: judgement.promptMs,
          cost: judgement.cost,
          comments: batch.map(({ id, change, start, text }) => ({ id, file: change.file, line: start + 1, text })),
          verdicts: judgement.verdicts,
        });
      } catch (error) {
        const reason = messageOf(error);
        failures.push({ blocks: batch, reason });
        log("warn", "branch comments not judged", { reason, comments: batch.length });
      }
    });
    if (context.abort.aborted) throw new Error(`${TOOL_NAME} aborted`);

    const all = flags.flat();
    suggested.set(context.sessionID, new Set(all.flatMap(({ lines }) => (lines && lines.length > 0 ? [keyOf(lines)] : []))));
    const unjudged = failures.reduce((sum, failure) => sum + failure.blocks.length, 0);
    log("info", "branch judged", { comments: blocks.length, flagged: all.length, unjudged, ms: Date.now() - started });
    return report({ base: found.base, files: found.files, blocks, flags: all, failures });
  };

  const tool: NonNullable<Hooks["tool"]> = {
    [TOOL_NAME]: {
      description: TOOL_DESCRIPTION,
      args: {
        base: z
          .string()
          .optional()
          .describe("Git ref to compare against. Default: the merge base of HEAD with origin/HEAD, main or master."),
        paths: z.array(z.string()).optional().describe("Files or directories to limit the review to, relative to the project directory."),
      },
      execute: run,
    },
  };

  const config = async (input: Config) => {
    input.command ??= {};
    if (input.command[COMMAND_NAME]) return;
    input.command[COMMAND_NAME] = { description: "judge the comments this branch adds and apply the verdicts [base] [paths]", template: COMMAND_TEMPLATE };
  };

  const unsuggested = (session: string, blocks: Block[]): Block[] => {
    const keys = suggested.get(session);
    if (!keys) return blocks;
    const left = blocks.filter((block) => !keys.has(keyOf(block.raw)));
    if (left.length < blocks.length)
      log("info", `comments written as ${TOOL_NAME} suggested; not judged again`, { comments: blocks.length - left.length });
    return left;
  };

  return { tool, config, unsuggested };
}
