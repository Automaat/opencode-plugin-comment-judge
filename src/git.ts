import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

import { diffChange, parseDiff, untrackedDiff, type FileDiff } from "./diff.ts";
import type { Change } from "./types.ts";

/**
 * Refs tried, in order, for the default branch whose merge base with HEAD is the base.
 */
export const DEFAULT_BRANCHES = ["origin/HEAD", "main", "master", "origin/main", "origin/master"];

const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

export type Base = { commit: string; label: string };

export type BranchChanges = { base: Base; files: number; changes: Change[] };

export type BranchQuery = { cwd: string; base?: string; paths?: string[]; signal?: AbortSignal };

function git(args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.quotePath=false", ...args],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        ...(signal ? { signal } : {}),
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`git ${args[0]}: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

const attempt = (args: string[], cwd: string, signal?: AbortSignal) =>
  git(args, cwd, signal).then(
    (out) => out.trim(),
    () => "",
  );

/**
 * The commit to diff against: the merge base of HEAD with base when given, or with the first default branch that exists.
 */
export async function resolveBase(cwd: string, base?: string, signal?: AbortSignal): Promise<Base> {
  const ref = base?.trim();
  if (ref) {
    if (ref.startsWith("-")) throw new Error(`base must be a git ref, got ${JSON.stringify(ref)}`);
    const commit = await attempt(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd, signal);
    if (!commit) throw new Error(`base ${JSON.stringify(ref)} is not a commit in this repository`);
    const merged = await attempt(["merge-base", "HEAD", commit], cwd, signal);
    return merged ? { commit: merged, label: `merge base of HEAD and ${ref}` } : { commit, label: ref };
  }
  for (const branch of DEFAULT_BRANCHES) {
    const merged = await attempt(["merge-base", "HEAD", branch], cwd, signal);
    if (merged) return { commit: merged, label: `merge base of HEAD and ${branch}` };
  }
  throw new Error(`no default branch found (tried ${DEFAULT_BRANCHES.join(", ")}); pass base`);
}

const readText = (path: string) => readFile(path, "utf8").catch(() => null);

async function untracked(cwd: string, root: string, paths: string[], signal?: AbortSignal): Promise<FileDiff[]> {
  const listed = await git(["ls-files", "--others", "--exclude-standard", "--full-name", "-z", "--", ...paths], cwd, signal);
  const diffs = await Promise.all(
    listed
      .split("\0")
      .filter(Boolean)
      .map(async (file) => {
        const content = await readText(join(root, file));
        return content === null ? null : (untrackedDiff(file, content) ?? null);
      }),
  );
  return diffs.filter((diff) => diff !== null);
}

/**
 * Every change between the base and the working tree, including uncommitted and untracked files, with files named relative to cwd.
 */
export async function branchChanges({ cwd, base, paths = [], signal }: BranchQuery): Promise<BranchChanges> {
  const [root = "", prefix = ""] = (await git(["rev-parse", "--show-toplevel", "--show-prefix"], cwd, signal)).split(/\r?\n/);
  const resolved = await resolveBase(cwd, base, signal);
  const diff = await git(
    [
      "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/",
      "--find-renames", "--unified=0", resolved.commit, "--", ...paths,
    ],
    cwd,
    signal,
  );
  const diffs = [...parseDiff(diff), ...(await untracked(cwd, root, paths, signal))];
  const changes = await Promise.all(
    diffs.map(async (entry) => {
      if (entry.deleted || entry.binary || entry.added.length === 0) return null;
      const content = await readText(join(root, entry.file));
      return content === null ? null : (diffChange(entry, content, posix.relative(prefix || ".", entry.file)) ?? null);
    }),
  );
  return { base: resolved, files: diffs.length, changes: changes.filter((change) => change !== null) };
}
