# Development workflow

How a change gets from an idea to a release. It applies to everyone: the maintainer, contributors and AI coding agents. GitHub enforces the parts marked **(enforced)**; the rest is how we work.

`main` is always releasable. Every change reaches it through a pull request that passed CI, and nothing else touches it.

## 1. Develop

- Set up as in [CONTRIBUTING.md](../CONTRIBUTING.md#setup) (`npm ci` installs the pre-commit hook).
- Start from an up-to-date `main` and keep each change to one topic. Open an issue first for a larger change.
- Cover behavior changes and regressions with focused tests ([test expectations](code-quality.md#test-expectations)).
- For substantial functionality or UI changes, also exercise the affected flows in a live browser against a local stack ([AGENTS.md](../AGENTS.md#local-stack-and-end-to-end-testing)).
- Update the docs under `docs/` when you change configuration, behavior or a migration.

## 2. Branch

Work on a short-lived branch named `type/topic`, with the same types as commits: `feat/chat-export`, `fix/session-pagination`, `docs/production-workflow`. Nobody pushes to `main`, the maintainer included **(enforced)**. Keep the branch current with `git rebase origin/main` (or **Update branch** on the pull request) rather than merging `main` into it.

## 3. Commit

- Write [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`, for example `fix(server): handle session pagination`. Keep each commit focused.
- The Husky pre-commit hook formats staged files, checks lint regressions and scans for secrets. Do not bypass it with `--no-verify`.
- Run `npm run verify` before every push. CI runs the same scripts, so a green `verify` predicts a green run.
- Never commit credentials, `.env` files, SQLite databases, `containers/.secrets/` or personal data.

## 4. Open a pull request

- Push the branch and open a pull request. Fill in the template: the problem, the resulting behavior and how you validated it (commands and results, and the checks you could not run). Add screenshots for visible UI changes. Open it as a draft until it is ready.
- **The title is the commit.** Pull requests are squash-merged, so the title becomes the one commit on `main` and the line in the release notes. It must be a Conventional Commit header **(enforced: the `pr-title` check)**:
  - types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`, `revert`, `style`;
  - an optional scope such as `(web)`, and `!` before the colon for a breaking change: `feat(cli)!: rename --dir to --home`;
  - a summary with no trailing period, and 150 characters at most in all.

## 5. Pass the checks

A pull request merges only when every required check passes **(enforced)**: `pr-title`, `static`, `test`, `web`, `android` and `images (control|gateway|reader|egress|exec|browser)`. The `android` and `images` jobs report success without building when a change cannot affect them.

When a check fails, fix the cause. Do not lower coverage floors, add skips, loosen timeouts or weaken a check to make it pass. A flaky test is a bug: fix it or open an issue and say so in the pull request.

## 6. Merge

- **Squash merge only**, with the branch up to date with `main` and every review conversation resolved **(enforced)**. History on `main` stays linear, one commit per pull request, and the branch is deleted after the merge.
- No approval is required, because the project has one maintainer and GitHub does not let anyone approve their own pull request. Contributors' pull requests are merged by the maintainer.
- **Agents merge their own pull requests** once every required check has passed: `gh pr merge --squash --auto` right after opening it, or `gh pr merge --squash` when it is green. An agent never merges with a failing or pending check, never uses an admin bypass and never merges someone else's pull request without being asked.

## 7. After the merge

Watch the CI run on `main`. If it goes red, fixing it comes before any other work: a fix-forward pull request, or a `revert:` pull request when the fix is not quick.

## Versions

Rei uses semantic versions. While it is `0.x`:

- **Patch** (`0.1.0` → `0.1.1`): fixes and changes an existing installation can take without doing anything, including a schema change that upgrades in place.
- **Minor** (`0.1.x` → `0.2.0`): new features, any breaking change to configuration, the HTTP or CLI interface, or Compose files, and raising `OLDEST_UPGRADABLE`, which is allowed only at a minor release ([database upgrades](versioning.md#database-upgrades)).
- **Major** (`1.0.0`): when the configuration, API and CLI are committed to. After 1.0, a breaking change needs a major release.

A pull request with a `!` in its title, or that raises `OLDEST_UPGRADABLE`, means the next release is at least a minor one.

## Release

Releases happen only when the maintainer asks for one.

1. Open a pull request titled `chore(release): vX.Y.Z` that bumps every manifest and the lockfile (`npm version X.Y.Z --workspaces --include-workspace-root --no-git-tag-version`) and merge it like any other.
2. Tag the merge commit on `main` once its CI is green, and push the tag. The tag starts the release workflow, which publishes the images, the Android app, the npm package and the GitHub Release. Only repository admins can push a `v*` tag **(enforced)**.
3. Never move or reuse a tag. If a release is bad, fix forward with the next patch release.

A red nightly run (the published package installed and upgraded from scratch) blocks the next release until it is fixed. The full procedure, the pre-release tags and recovering a failed run are in [versioning.md](versioning.md#releasing).

## Hotfix

A hotfix is a patch release made the same way: a `fix:` pull request to `main`, then a release pull request and a tag. There are no release branches; we add them only if more than one version ever needs support.

## Dependency updates

Dependabot opens update pull requests every week (`.github/dependabot.yml`). They follow the same rules: the title check, the required checks, squash merge.

- **Grouped minor and patch updates** merge once green. If one breaks, fix it on the Dependabot branch or in a pull request of your own.
- **Major updates** each get a focused look: fix what breaks and merge, or close the pull request with the reason and add an `ignore` entry for that version to `.github/dependabot.yml`.
- **Container base images** follow the Node major in `.nvmrc`: move them together, in one pull request.

## What agents must never do

- Push to `main`, or push or move a tag without the maintainer's word.
- Merge with a failing or pending check, use an admin bypass, or force-push a branch someone else is working on.
- Use `pull_request_target`, add an unpinned action (pin by full commit SHA with the version in a comment), or put secrets in a workflow.
- Commit credentials or personal data, or weaken a check to make it pass.
