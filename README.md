# opencode-plugin-comment-judge

[![npm version](https://img.shields.io/npm/v/opencode-plugin-comment-judge)](https://www.npmjs.com/package/opencode-plugin-comment-judge) [![npm provenance](https://img.shields.io/badge/provenance-SLSA_v1-blue?logo=npm)](https://www.npmjs.com/package/opencode-plugin-comment-judge) [![license](https://img.shields.io/npm/l/opencode-plugin-comment-judge)](LICENSE)

An [opencode](https://opencode.ai) plugin that puts a model between your agent and the comments it writes. Every comment an edit adds is judged: the ones that restate the code or tell the story of the change are removed or rewritten before the file is touched, and the ones that explain something the code cannot say stay.

> **Status:** pre-1.0, verified against opencode 1.18.30. Verdicts, messages and options may change between minor versions.

## Why

Coding agents comment as if they were narrating a screen share: `// Loop over the items`, `// Fix: previously SKUs with different case were duplicated`, a paragraph above a one-line guard. Telling them not to in `AGENTS.md` holds for a few turns. Linters that match on wording cannot tell a restatement from a reason. A model reading the comment next to its code can.

## What it does

1. On every `edit`, `write`, `multiedit` and `apply_patch` call, it finds the comment lines the edit adds. Comments already in the file are left alone, and an edit that adds none never reaches the model.
2. It asks a model for a verdict on each comment in a short-lived child session: **keep**, **remove** or **rewrite**. The model sees the code around each comment and the session's latest prompt, so it can tell a lasting reason from the history of the fix.
3. It writes the verdicts into the tool call before it runs, in the file's own comment syntax, and adds a note to the tool result so the agent's next edit still matches the file.
4. When a verdict cannot be applied in place (a rewrite without text, or lines cut out of a `/* */` comment), it rejects the edit with the suggestions and the agent re-issues it. The same comments sent a second time go through, with the suggestions attached.
5. If the judge errors or runs past `timeoutMs`, the edit is written unjudged and a warning is logged.

### Example

Prompt: *Bug: adding sku "abc-1" after "ABC-1" gives the cart two lines instead of one. Fix addItem and leave a comment explaining the fix.*

The agent wrote:

```ts
  // SKUs are case-insensitive: normalize both sides to lowercase so that
  // adding "abc-1" merges with an existing "ABC-1" line instead of
  // creating a duplicate line in the cart.
```

The judge answered `rewrite`, because the comment "frames it around the specific bug scenario with example SKUs, which is task context that won't matter later", and the file got:

```ts
  // SKUs are case-insensitive; match lines on the lowercased SKU.
```

## Install

Add the plugin to `opencode.json`. opencode installs npm plugins itself when it starts.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-plugin-comment-judge"],
  "small_model": "anthropic/claude-haiku-4-5"
}
```

## Configuration

```json
{
  "plugin": [["opencode-plugin-comment-judge", { "model": "anthropic/claude-haiku-4-5", "timeoutMs": 20000 }]]
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `model` | `small_model` | `provider/model` the judge runs on. With neither set, the session's default model answers, which is usually the expensive one |
| `timeoutMs` | `30000` | How long an edit waits for a verdict before it is written unjudged |
| `log` | none | Path of a JSON Lines file recording every comment, verdict and change. Useful for tuning and for reporting a wrong verdict; it contains your code |

Diagnostics always go to opencode's own log under the `comment-judge` service.

## What the judge keeps, removes and rewrites

The full instructions are in [`src/judge.ts`](src/judge.ts). In short, a comment stays only if it will still be true and useful to someone reading the file in a year who knows nothing about this change.

| Keep | Remove | Rewrite, or remove if nothing lasting is left |
| --- | --- | --- |
| Directives tools read: linter, compiler and type checker pragmas, build tags, shebangs | Restating the next lines, or what identifiers already say | The bug, ticket, request or review behind the change, and what the code used to do |
| Why the code is the way it is, when the code cannot say it | Section banners and separators | Talking to the reader: "note that", "we", "as discussed" |
| Public API contracts: errors, units, side effects | Comments on self-explanatory code | A useful point buried in several sentences |
| TODO or FIXME with a concrete follow-up, license headers, links to constraints still in force | | |

## Cost and latency

One model call per edit that adds comments, and none otherwise. Each call carries the comments, a few lines of code around each, the session's latest prompt (capped at 2000 characters) and the judge instructions. With a fast small model, verdicts took 2 to 9 seconds in testing, and an occasional call ran past 30. Pick the fastest model whose judgement you trust, and set `timeoutMs` to what you are willing to wait.

## Limitations

- Comments are found line by line from the file name: `//`, `/* */` and `*` in C-like files; `#` in shell, Python, Ruby, YAML, TOML, Nix, Terraform, Dockerfiles and Makefiles; `--` in SQL, Lua and Haskell; and trailing comments after code. Python docstrings, JSX comments and `<!-- -->` are not seen.
- "Added" means lines in the new text that are not in the old text, counted as a multiset, so a moved comment counts as kept.
- The judge is prompted as opencode's `build` agent, so it carries that agent's system prompt, and anything that attributes spend by agent sees `build`. Its session also runs other plugins' chat hooks.
- Verdicts are not deterministic: the same comment can be worded differently on another run.
- It relies on opencode behaviour that is not a documented contract: structured output through `format`, tool arguments being mutable in `tool.execute.before`, and the `apply_patch` format.

## Reporting a wrong verdict

Open an issue with the [wrong verdict](https://github.com/Automaat/opencode-plugin-comment-judge/issues/new?template=wrong-verdict.yml) template: the comment, the code around it, what the judge did and what it should have done. These reports become the cases the instructions are tuned against.

## Trying a working copy

```sh
scripts/try.sh
COMMENT_JUDGE_MODEL=anthropic/claude-haiku-4-5 scripts/try.sh ~/tmp/comment-judge
```

The script creates a scratch project that loads `src/index.ts` from this checkout and writes the judge log into the project. It prints the commands to run opencode there, including an isolated variant that keeps your providers but drops your global `AGENTS.md`, instructions and `plugin/` directory, so the agent writes comments the way it would on a machine without them. It needs `jq`.

`opencode run` started without a terminal, from a script or another agent, hangs until stdin is redirected: append `</dev/null`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
