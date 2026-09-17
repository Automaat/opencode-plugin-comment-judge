import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { branchChanges, resolveBase } from "../src/git.ts";
import { comments, repository } from "./helpers.ts";

const CART = "export function total(items: number[]): number {\n  return items.length;\n}\n";

function feature() {
  const repo = repository({ "src/cart.ts": CART, "src/old.ts": "// kept from main\nexport const old = 1;\n", "logo.bin": "a\0b" });
  const base = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "-b", "feature");
  repo.write({ "src/cart.ts": CART.replace("  return", "  // Count the items\n  return") });
  repo.commit("comment the total");
  return { repo, base };
}

describe("resolveBase", () => {
  it("defaults to the merge base of HEAD with main", async () => {
    const { repo, base } = feature();
    repo.git("checkout", "-q", "main");
    repo.write({ "later.ts": "// on main after the branch\n" });
    repo.commit("later");
    repo.git("checkout", "-q", "feature");
    assert.deepEqual(await resolveBase(repo.root), { commit: base, label: "merge base of HEAD and main" });
  });

  it("prefers the remote's default branch", async () => {
    const { repo, base } = feature();
    repo.git("branch", "-q", "-m", "main", "trunk");
    repo.git("update-ref", "refs/remotes/origin/trunk", base);
    repo.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    assert.deepEqual(await resolveBase(repo.root), { commit: base, label: "merge base of HEAD and origin/HEAD" });
  });

  it("takes the merge base with a given ref", async () => {
    const { repo, base } = feature();
    assert.deepEqual(await resolveBase(repo.root, "main"), { commit: base, label: "merge base of HEAD and main" });
  });

  it("refuses a base that git would read as an option, or that names no commit", async () => {
    const { repo } = feature();
    await assert.rejects(resolveBase(repo.root, "--output=pwned"), /must be a git ref/);
    await assert.rejects(resolveBase(repo.root, "no-such-branch"), /is not a commit/);
  });

  it("asks for a base when there is no default branch", async () => {
    const { repo } = feature();
    repo.git("branch", "-q", "-D", "main");
    await assert.rejects(resolveBase(repo.root), /no default branch found.*pass base/);
  });
});

describe("branchChanges", () => {
  it("reads committed, uncommitted and untracked changes, and skips deleted and binary files", async () => {
    const { repo, base } = feature();
    repo.write({ "src/new.py": "# brand new\nx = 1\n", "logo.bin": "a\0c", "src/staged.ts": "// staged\n" });
    repo.git("add", "src/staged.ts");
    rmSync(join(repo.root, "src/old.ts"));

    const found = await branchChanges({ cwd: repo.root });
    assert.equal(found.base.commit, base);
    assert.equal(found.files, 5);
    assert.deepEqual(comments(found.changes), {
      "src/cart.ts": ["  // Count the items"],
      "src/new.py": ["# brand new"],
      "src/staged.ts": ["// staged"],
    });
  });

  it("reads a renamed file under its new name", async () => {
    const { repo } = feature();
    repo.git("mv", "src/old.ts", "src/renamed.ts");
    repo.write({ "src/renamed.ts": "// kept from main\n// why it moved\nexport const old = 1;\n" });
    repo.commit("rename");
    const found = await branchChanges({ cwd: repo.root });
    assert.deepEqual(comments(found.changes)["src/renamed.ts"], ["// why it moved"]);
  });

  it("limits the diff to the given paths and names files relative to the directory it runs in", async () => {
    const { repo } = feature();
    repo.write({ "docs/a.md": "<!-- a note -->\n", "src/other.ts": "// other\n" });
    const found = await branchChanges({ cwd: join(repo.root, "src"), paths: ["cart.ts", "../docs"] });
    assert.deepEqual(Object.keys(comments(found.changes)).sort(), ["../docs/a.md", "cart.ts"]);
  });

  it("finds the comments of a CRLF file", async () => {
    const { repo } = feature();
    repo.write({ "src/win.ts": "x();\r\n// why\r\ny();\r\n" });
    repo.commit("crlf");
    const found = await branchChanges({ cwd: repo.root });
    assert.deepEqual(comments(found.changes)["src/win.ts"], ["// why"]);
  });

  it("fails outside a git repository", async () => {
    const outside = mkdtempSync(join(tmpdir(), "comment-judge-nogit-"));
    await assert.rejects(branchChanges({ cwd: outside }), /git rev-parse/);
  });
});
