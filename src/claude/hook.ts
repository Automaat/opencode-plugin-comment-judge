import { blocksOf } from "../comments.ts";
import { evaluate } from "../evaluate.ts";
import { repositoryRules } from "../rules.ts";
import type { Verdict } from "../types.ts";
import { claudeEdit } from "./changes.ts";
import type { ClaudeRequest } from "./judge.ts";
import { sessionState } from "./state.ts";
import { latestPrompt } from "./transcript.ts";

/**
 * The fields of a Claude Code PreToolUse or PostToolUse hook input this hook reads.
 */
export type HookInput = {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
};

export type HookOutput = Record<string, unknown> | undefined;

export type HookDeps = {
  judge: (request: ClaudeRequest) => Promise<Verdict[]>;
  stateRoot: string;
  projectDir: string | undefined;
  warn: (message: string) => void;
};

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

function postToolUse(input: HookInput, deps: HookDeps): HookOutput {
  if (!input.session_id || !input.tool_use_id) return undefined;
  const note = sessionState(deps.stateRoot, input.session_id).takeNote(input.tool_use_id);
  if (!note) return undefined;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: note } };
}

async function preToolUse(input: HookInput, deps: HookDeps): Promise<HookOutput> {
  const edit = claudeEdit(input.tool_name ?? "", input.tool_input);
  if (!edit) return undefined;
  const blocks = blocksOf(edit.changes);
  if (blocks.length === 0) return undefined;

  const root = deps.projectDir || input.cwd || process.cwd();
  const rules = repositoryRules(root, (level, message) => {
    if (level === "warn" || level === "error") deps.warn(`comment-judge: ${message}`);
  })();
  let verdicts: Verdict[];
  try {
    verdicts = await deps.judge({ blocks, task: latestPrompt(input.transcript_path), rules });
  } catch (error) {
    const message = `comment-judge: judge failed, edit written unjudged: ${reasonOf(error)}`;
    deps.warn(message);
    return { systemMessage: message };
  }

  const state = sessionState(deps.stateRoot, input.session_id ?? "");
  const outcome = evaluate(blocks, verdicts, { unchanged: edit.unchanged, restore: () => {} }, state.rejections, "old_string");
  if (outcome.kind === "kept") return undefined;
  const { flags } = outcome;

  if (outcome.kind === "rejected")
    return {
      systemMessage: `comment-judge: edit rejected: ${flags.length} comment(s) to fix`,
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: outcome.reason },
    };
  if (input.tool_use_id) state.saveNote(input.tool_use_id, outcome.note);
  if (outcome.kind === "repeated") return undefined;
  return {
    systemMessage: `comment-judge: ${flags.length} of ${blocks.length} comment block(s) removed or rewritten`,
    hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: edit.input },
  };
}

/**
 * Answers one hook call. PreToolUse judges the comments an Edit, Write or MultiEdit adds and returns the rewritten input or a denial; PostToolUse returns the note PreToolUse left for the same tool call. Returns nothing when the call goes ahead as sent.
 */
export async function handle(input: HookInput, deps: HookDeps): Promise<HookOutput> {
  if (input.hook_event_name === "PostToolUse") return postToolUse(input, deps);
  if (input.hook_event_name === "PreToolUse") return preToolUse(input, deps);
  return undefined;
}
