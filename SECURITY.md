# Security policy

## Reporting a vulnerability

Report it privately through [GitHub's private vulnerability reporting](https://github.com/Automaat/opencode-plugin-comment-judge/security/advisories/new). Do not open a public issue or pull request. Include the plugin version, the opencode version, the judge model, and the steps to reproduce.

## Supported versions

The latest release. The package is pre-1.0 and has no maintained release branches; fixes go to `main` and ship in the next release.

## What is worth reporting

This plugin changes the arguments of file edits before opencode writes them, based on the answer of a model that reads untrusted text: the code and comments being edited, and the session's prompt. The findings that matter most let that text change more than comments:

- A comment, verdict or rewrite that makes the plugin write anything other than comment text: code, a block comment closed early with code after it, a change to a different file, or a change to lines the edit did not add.
- An edit that reaches the file in a form the agent was not told about, or that the judge rejected.
- Code, comments or prompts sent anywhere other than the judge model, opencode's log, and the `log` file when one is configured.
- A judge session that gains tools, runs tool calls, or outlives the edit it was created for.
- A `judge_comments` argument that makes `git` do anything but read: a base or path read as an option, or a command run through a shell.
- An edit that skips the judge because it writes a `judge_comments` suggestion, when its comment is not exactly one the tool suggested in that session.

The repository rules in `.comment-judge.md` are part of the judge's instructions, so anyone who can commit to the repository can steer verdicts: keep comments the defaults would remove, or remove ones they would keep. That is intended. The rules reach the plugin through the same verdicts as everything else, so they can still only ever produce comment text; rules that make the plugin write anything else fall under the findings above.

The Claude Code hook, `comment-judge-claude`, sends the same text through `claude -p`: the comments an edit adds, the code around them, the session's latest prompt read from its transcript, and the repository rules. That call runs under the account Claude Code is logged in with, on the model in `COMMENT_JUDGE_MODEL`. The same findings apply to it, and so do these:

- A `claude -p` judge call that gets tools, MCP servers, settings, hooks or plugins, or that loads the hook again and judges its own output.
- An edit whose `updatedInput` changes anything but comment text, or that skips a permission prompt Claude Code would otherwise show.
- Notes or rejection records written anywhere but the private `comment-judge-claude-<uid>` directory under the system temp directory, or readable by another user.

A verdict you disagree with is not a vulnerability; use the [wrong verdict](https://github.com/Automaat/opencode-plugin-comment-judge/issues/new?template=wrong-verdict.yml) issue template.
