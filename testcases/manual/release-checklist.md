# Release Checklist

Use this checklist before pushing a release tag such as `v0.1.0-beta.1` or
`v0.1.0`.

## Preflight

- release changes are merged to `main`
- [package.json](../../package.json) version already matches the intended tag without the `v` prefix
- [CHANGELOG.md](../../CHANGELOG.md) has a section for that exact version
- CI on `main` is green
- npm publish credentials are available as `NPM_TOKEN`
- GitHub Actions `release` environment is configured and approved

## Automated Checks

Run locally if needed before tagging:

```bash
npm ci
npm run build
npm test
npm pack --dry-run
```

## Manual QA Matrix

Run the terminal smoke test matrix described in
[manual-terminal-qa.md](./manual-terminal-qa.md):

- `tmux + Codex`
- `tmux + Claude Code`
- `iTerm2 + Codex`
- `iTerm2 + Claude Code`

Also verify:

- daemon restart and state recovery
- one `local_event` append/read flow after restart
- one `github_repo` or `github_repo_ci` source read path if credentials are available

## Versioning Rules

- beta builds should use semver prerelease versions such as `0.1.0-beta.1`
- stable builds should use plain semver such as `0.1.0`
- the Git tag must be `v<package.json version>`
- prerelease tags publish to npm with the `beta` dist-tag
- stable tags publish to npm with the `latest` dist-tag

## Release Steps

1. Update `package.json` version and add the matching `CHANGELOG.md` section in a PR.
2. Merge the PR to `main`.
3. Run the manual QA matrix.
4. Create and push the release tag:

```bash
git checkout main
git pull --ff-only
git tag v0.1.0-beta.1
git push origin v0.1.0-beta.1
```

5. Wait for the `Release` GitHub Actions workflow to complete.
6. Verify the npm package and GitHub Release page.

## Post-Release Checks

- `npm view @holon-run/agentinbox version` matches the intended release
- GitHub Release exists for the tag and includes the packaged tarball
- install smoke still works:

```bash
npx @holon-run/agentinbox --help
```

- note any manual QA findings or known beta limitations in the release notes
