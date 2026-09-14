# Contributing

## Setting up

```sh
mise install      # node, oxlint, markdownlint-cli2, actionlint and zizmor at the pinned versions
mise run install  # npm ci from the lockfile
```

Tool versions are pinned in [`mise.toml`](mise.toml), so a local run and CI resolve the same binaries.

## The gate

```sh
mise run check
```

Typecheck, oxlint, markdownlint, actionlint with zizmor, the tests and the build. Every CI job runs one of these tasks, so a green local run and a green CI run mean the same thing. While you work, run the narrow one: `mise run test`, `mise run typecheck`, `mise run lint:js`, `mise run lint:md`, `mise run lint:actions` or `mise run build`.

No lint suppressions. If a rule is wrong for a case, raise it in the pull request.

## What a change carries

- **A test.** Tests live in [`test/`](test), one file per module. Write the test first and watch it fail.
- **Evidence for prompt changes.** A change to the judge instructions in [`src/judge.ts`](src/judge.ts) names the verdicts it fixes: link the wrong-verdict issues, or paste the before and after from a `log` file.
- **Comments that say why.** Never what. This project in particular has no excuse.
- **README updates.** If the change makes a claim in the [README](README.md) false, fix it in the same pull request.

To try a change inside opencode, use [`scripts/try.sh`](scripts/try.sh).

## Commits

[Conventional Commits](https://www.conventionalcommits.org/) with a required scope, a title of 50 characters or fewer, imperative, with no issue reference. Sign and sign off: `git commit -s -S`.

Scopes inside `src/` name the module: `judge`, `comments`, `changes`, `rewrite`, `messages`, `options`, `plugin`. Outside it: `ci(actions)`, `ci(release)`, `build(build)`, `docs(readme)`, `test(<module>)`, `chore(deps)`.

## Pull requests

Small and single-purpose. `main` takes squash merges, and the pull request title becomes the commit that release-please reads, so it follows the commit rules above. The template asks for three sections: Motivation, Implementation information and Supporting documentation. Say which validation you ran, specifically.

## Releasing

[release-please](https://github.com/googleapis/release-please) keeps a release pull request open against `main`. Merging it tags `vX.Y.Z`, creates the GitHub release, and the same workflow runs the gate on the tag and publishes to npm with provenance through [trusted publishing](https://docs.npmjs.com/trusted-publishers). Until the repository variable `NPM_PUBLISH_ENABLED` is `true`, the publish step is a dry run.

One-time setup:

1. Create an environment named `npm` in the repository settings.
2. On npmjs.com, add a trusted publisher to `opencode-plugin-comment-judge`: GitHub Actions, repository `Automaat/opencode-plugin-comment-judge`, workflow `release.yml`, environment `npm`. If npm will not configure one for a name that has never been published, publish the first version once by hand from the maintainer's npm account, then add it.
3. Set the repository variable `NPM_PUBLISH_ENABLED` to `true`.
4. Optionally add a `RELEASE_PLEASE_TOKEN` secret, a fine-grained token with contents and pull requests write access. With the default token, GitHub does not start CI on the release pull request.

## Code of conduct

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies to everything that happens here.
