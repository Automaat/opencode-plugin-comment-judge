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

[release-please](https://github.com/googleapis/release-please) runs on every push to `main` and keeps a release pull request open against it. The first version is `0.1.0`, set by `initial-version` in [`release-please-config.json`](release-please-config.json). Merging the release pull request tags `vX.Y.Z` and creates the GitHub release, and the same workflow runs `mise run check` on the release commit and publishes to npm with provenance through [trusted publishing](https://docs.npmjs.com/trusted-publishers). The provenance attestation names `Automaat/opencode-plugin-comment-judge`, `.github/workflows/release.yml` and `refs/heads/main`. Until the repository variable `NPM_PUBLISH_ENABLED` is `true`, the publish job only runs `npm publish --dry-run`.

release-please uses the default token unless a `RELEASE_PLEASE_TOKEN` secret exists. With the default token GitHub does not start CI on the release pull request, so it shows no checks; the publish job still runs the gate before publishing. To get CI on release pull requests, add `RELEASE_PLEASE_TOKEN` as a fine-grained token with contents and pull requests write access. This repository does not have one yet.

### Setting up publishing for a new package or a fork

npm cannot configure a trusted publisher for a package name that has never been published ([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the first version is published by hand and CI publishes every version after it. These are the steps this package went through; in a fork, substitute your package name and repository.

1. Create an environment named `npm` in the repository settings, and under deployment branches allow only `main`.
2. Merge the first release pull request with `NPM_PUBLISH_ENABLED` unset. The workflow creates the tag and the GitHub release, and the publish job stops at the dry run.
3. Publish that version from the maintainer's npm account. Check out the tag and run `mise run install`, then log in and publish with a separate npm config so the credentials stay out of your default `~/.npmrc`:

   ```sh
   NPM_CONFIG_USERCONFIG=~/.npmrc-personal mise exec -- npm login
   NPM_CONFIG_USERCONFIG=~/.npmrc-personal mise exec -- npm publish --access public --provenance=false
   ```

   `--provenance=false` overrides `publishConfig.provenance`, because provenance can only be generated in CI. Publishing asks for 2FA: with a security key, run it in a real terminal, since it waits for approval in the browser; with an authenticator app, add `--otp=<code>`.
4. Add the trusted publisher. With npm 11.15 or later, and 2FA again:

   ```sh
   NPM_CONFIG_USERCONFIG=~/.npmrc-personal mise exec -- npm trust github opencode-plugin-comment-judge --file release.yml --repo Automaat/opencode-plugin-comment-judge --env npm --allow-publish
   ```

   Or on npmjs.com, in the package settings: GitHub Actions, the repository, workflow `release.yml`, environment `npm`. npm grants it publish and stage publish.
5. In the package settings on npmjs.com, set publishing access to "Require two-factor authentication and disallow tokens". CI publishes through the trusted publisher, so no npm token is needed anywhere.
6. Set the repository variable `NPM_PUBLISH_ENABLED` to `true`. The next merged release pull request is published by CI with provenance.
7. Optionally add the `RELEASE_PLEASE_TOKEN` secret described above.

## Code of conduct

[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) applies to everything that happens here.
