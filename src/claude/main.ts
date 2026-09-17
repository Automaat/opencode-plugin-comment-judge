import { text } from "node:stream/consumers";

import { handle, type HookInput } from "./hook.ts";
import { claudeSettings, GUARD_ENV, judgeWithClaude } from "./judge.ts";
import { prune, stateRoot } from "./state.ts";

type Streams = { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream };

/**
 * Runs the hook as Claude Code calls it: input JSON on stdin, output JSON on stdout, warnings on stderr. Always resolves to exit code 0, so a failing hook never blocks an edit.
 */
export async function main({ stdin, stdout, stderr }: Streams, env: NodeJS.ProcessEnv): Promise<number> {
  if (env[GUARD_ENV] === "1") return 0;
  const warn = (message: string) => {
    stderr.write(`${message}\n`);
  };
  try {
    const input: HookInput = JSON.parse(await text(stdin));
    const settings = claudeSettings(env, warn);
    const root = stateRoot();
    prune(root);
    const output = await handle(input, {
      judge: async (request) => (await judgeWithClaude(settings, request, env)).verdicts,
      stateRoot: root,
      projectDir: env.CLAUDE_PROJECT_DIR,
      warn,
    });
    if (output) stdout.write(`${JSON.stringify(output)}\n`);
  } catch (error) {
    warn(`comment-judge: hook failed, edit left as sent: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}
