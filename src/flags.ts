import { createHash } from "node:crypto";

import { replacement } from "./rewrite.ts";
import type { Block, Flag, Verdict } from "./types.ts";

export function flagged(blocks: Block[], verdicts: Verdict[]): Flag[] {
  return verdicts
    .filter((verdict) => verdict.action !== "keep")
    .flatMap((verdict) => {
      const block = blocks.find((candidate) => candidate.id === verdict.id);
      if (!block) return [];
      const flag: Flag = { block, verdict };
      flag.lines = replacement(flag);
      return [flag];
    });
}

export function fingerprint(flags: Flag[]): string {
  return createHash("sha256")
    .update(flags.map(({ block }) => `${block.change.file}\0${block.text}`).join("\0"))
    .digest("hex");
}
