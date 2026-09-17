import { fingerprint, flagged } from "./flags.ts";
import { appliedDespiteRepeat, onlyRejectedComments, rejection, rewrittenNote } from "./messages.ts";
import { applyInPlace } from "./rewrite.ts";
import type { Block, Flag, Verdict } from "./types.ts";

/**
 * What happens to an edit once its comments are judged: written unchanged, written with the verdicts applied, written as sent after a repeated rejection, or rejected with a reason for the agent.
 */
export type Outcome =
  | { kind: "kept" }
  | { kind: "rewritten"; flags: Flag[]; note: string }
  | { kind: "repeated"; flags: Flag[]; note: string }
  | { kind: "rejected"; flags: Flag[]; reason: string };

/**
 * The tool call the blocks came from: whether it still changes the file after the verdicts were applied to it, and how to put it back as sent.
 */
export type EditCall = { unchanged: () => boolean; restore: () => void };

/**
 * Fingerprints of the comments already rejected in a session, so the same comments sent again go through.
 */
export type Rejections = { has: (key: string) => boolean; add: (key: string) => void };

/**
 * Decides what happens to an edit from its verdicts, applying them to the edit's changes when they all fit in place. `field` names the argument a later edit must match in the note.
 */
export function evaluate(blocks: Block[], verdicts: Verdict[], edit: EditCall, rejected: Rejections, field = "oldString"): Outcome {
  const flags = flagged(blocks, verdicts);
  if (flags.length === 0) return { kind: "kept" };

  const inPlace = flags.every(({ lines }) => lines);
  if (inPlace) {
    applyInPlace(flags);
    if (!edit.unchanged()) return { kind: "rewritten", flags, note: rewrittenNote(flags, field) };
    edit.restore();
  }

  const key = fingerprint(flags);
  if (rejected.has(key)) return { kind: "repeated", flags, note: appliedDespiteRepeat(flags) };
  rejected.add(key);
  return { kind: "rejected", flags, reason: inPlace ? onlyRejectedComments(flags) : rejection(flags) };
}
