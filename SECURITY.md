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

A verdict you disagree with is not a vulnerability; use the [wrong verdict](https://github.com/Automaat/opencode-plugin-comment-judge/issues/new?template=wrong-verdict.yml) issue template.
