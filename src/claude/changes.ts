import { currentContent, textChange } from "../changes.ts";
import type { Change } from "../types.ts";

export const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

/**
 * A Claude Code file tool call read as changes. Commits write into `input`, a copy of the tool input that becomes `updatedInput`; `unchanged` is true when a commit left an edit replacing text with itself, which Claude Code refuses.
 */
export type ClaudeEdit = { input: Record<string, any>; changes: Change[]; unchanged: () => boolean };

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function claudeEdit(tool: string, toolInput: unknown): ClaudeEdit | undefined {
  if (!CLAUDE_EDIT_TOOLS.has(tool) || !toolInput || typeof toolInput !== "object") return undefined;
  const input: Record<string, any> = structuredClone(toolInput);
  const file = input.file_path;
  if (typeof file !== "string" || !file) return undefined;

  if (tool === "Edit") {
    const change = textChange(file, text(input.old_string), text(input.new_string), (written) => {
      input.new_string = written;
    });
    return { input, changes: [change], unchanged: () => input.new_string === input.old_string };
  }
  if (tool === "Write") {
    const change = textChange(file, currentContent(file), text(input.content), (written) => {
      input.content = written;
    });
    return { input, changes: [change], unchanged: () => false };
  }
  if (!Array.isArray(input.edits)) return undefined;
  const edits: Record<string, any>[] = input.edits.filter((edit: unknown) => edit && typeof edit === "object");
  const changes = edits.map((edit) =>
    textChange(file, text(edit.old_string), text(edit.new_string), (written) => {
      edit.new_string = written;
    }),
  );
  return { input, changes, unchanged: () => edits.some((edit) => edit.new_string === edit.old_string) };
}
