import type { Plugin } from "@opencode-ai/plugin";
import { appendFileSync } from "node:fs";

import { changesOf, EDIT_TOOLS } from "./changes.ts";
import { blocksOf } from "./comments.ts";
import { fingerprint, flagged } from "./flags.ts";
import { judge } from "./judge.ts";
import { appliedDespiteRepeat, onlyRejectedComments, rejection, rewrittenNote } from "./messages.ts";
import { settings } from "./options.ts";
import { applyInPlace } from "./rewrite.ts";
import { repositoryRules, rulesRoot } from "./rules.ts";

const SERVICE = "comment-judge";
const TASK_CHARS = 2000;

type Level = "debug" | "info" | "warn" | "error";

/**
 * Has a model judge every comment an agent's edit adds, then removes or rewrites the ones that do not earn their place before the edit is written.
 */
export const CommentJudge: Plugin = async ({ client, directory, worktree }, options) => {
  const warnings: string[] = [];
  const config = settings(options, (message) => {
    warnings.push(message);
  });
  const judges = new Set<string>();
  const tasks = new Map<string, string>();
  const notes = new Map<string, string>();
  const rejected = new Map<string, Set<string>>();

  const log = (level: Level, message: string, extra?: Record<string, unknown>) => {
    if (config.log) {
      try {
        appendFileSync(config.log, `${JSON.stringify({ time: new Date().toISOString(), level, message, ...extra })}\n`);
      } catch {}
    }
    void client.app.log({ body: { service: SERVICE, level, message, ...(extra ? { extra } : {}) } }).catch(() => null);
  };

  const toast = (message: string, variant: "info" | "warning" | "error") => {
    void Promise.resolve()
      .then(() => client.tui?.showToast?.({ body: { title: SERVICE, message, variant } }))
      .catch(() => null);
  };

  for (const warning of warnings) log("warn", warning);
  const rules = repositoryRules(rulesRoot(worktree, directory), log);

  return {
    "chat.message": async (input, output) => {
      if (judges.has(input.sessionID)) return;
      const text = output.parts
        .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
        .join("\n")
        .trim();
      if (text) tasks.set(input.sessionID, text.slice(-TASK_CHARS));
    },

    "tool.execute.before": async (input, output) => {
      if (judges.has(input.sessionID) || !EDIT_TOOLS.has(input.tool)) return;
      const started = Date.now();
      const blocks = blocksOf(changesOf(input.tool, output.args, directory));
      if (blocks.length === 0) return;

      const judgement = await judge(client, config, {
        parent: input.sessionID,
        blocks,
        task: tasks.get(input.sessionID) ?? "",
        rules: rules(),
        track: (session) => {
          judges.add(session);
        },
      }).catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        log("warn", "judge failed; edit written unjudged", { tool: input.tool, reason, ms: Date.now() - started });
        toast(`judge failed, edit written unjudged: ${reason}`, "warning");
        return null;
      });
      if (!judgement) return;
      log("info", "judged", {
        tool: input.tool,
        model: judgement.model,
        promptMs: judgement.promptMs,
        cost: judgement.cost,
        structured: judgement.structured,
        comments: blocks.map(({ id, change, text }) => ({ id, file: change.file, text })),
        verdicts: judgement.verdicts,
      });

      const flags = flagged(blocks, judgement.verdicts);
      if (flags.length === 0) return;

      const inPlace = flags.every(({ lines }) => lines);
      if (inPlace) {
        const original = output.args.newString;
        applyInPlace(flags);
        if (input.tool !== "edit" || output.args.newString !== output.args.oldString) {
          log("info", "comments changed in place", {
            tool: input.tool,
            changed: flags.map(({ block, verdict, lines }) => ({ id: block.id, action: verdict.action, from: block.raw, to: lines })),
          });
          toast(`${flags.length} of ${blocks.length} comment block(s) removed or rewritten`, "info");
          notes.set(input.callID, rewrittenNote(flags));
          return;
        }
        output.args.newString = original;
      }

      const seen = rejected.get(input.sessionID) ?? new Set<string>();
      rejected.set(input.sessionID, seen);
      const key = fingerprint(flags);
      if (seen.has(key)) {
        log("info", "same comments re-sent after a rejection; edit written as sent", { tool: input.tool });
        notes.set(input.callID, appliedDespiteRepeat(flags));
        return;
      }
      seen.add(key);
      log("info", "edit rejected", { tool: input.tool, blocks: flags.map(({ block }) => block.id) });
      toast(`edit rejected: ${flags.length} comment(s) to fix`, "warning");
      throw new Error(inPlace ? onlyRejectedComments(flags) : rejection(flags));
    },

    "tool.execute.after": async (input, output) => {
      const note = notes.get(input.callID);
      if (!note) return;
      notes.delete(input.callID);
      output.output = output.output ? `${output.output}\n\n${note}` : note;
    },
  };
};
