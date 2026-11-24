# Contributing to Rei

Thanks for taking an interest. Rei is a personal project with no roadmap beyond its maintainer's needs, so **please open an issue before you start a larger change**. That saves you from writing a pull request that does not fit. Bug reports, small fixes and ideas you found useful in your own build are always welcome. Forking and adapting Rei for yourself is encouraged.

Security problems go through [private vulnerability reporting](SECURITY.md), not public issues.

By contributing you agree that your work is released under the [MIT License](LICENSE). Everyone taking part is expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

You need Node.js 26 or newer. Docker with Compose v2 is only needed to run the whole stack.

```sh
git clone https://github.com/sheldonxxxx/Rei.git
cd Rei
npm ci                                        # installs the workspaces and the Husky pre-commit hook
REI_MODEL_MODE=faux npm start -w @rei/server  # server with a simulated model
npm run dev -w @rei/web                       # Vite on :5173, proxying to :8787
```

The repository layout and the rules for AI coding agents are in [AGENTS.md](AGENTS.md). Follow the style of the code around your change: two-space indentation, double quotes, semicolons, strict TypeScript, and `.ts`/`.tsx` extensions on relative imports. Biome formats the code; run `npm run format` before you commit.

## Before you open a pull request

Run the full local gate from the repository root:

```sh
npm run verify
```

It runs `npm run check:static` (formatting, lint regressions, the contract check, types, architecture, dependency and secret checks), then every test project with coverage floors, then the production web build. CI runs the same scripts. [docs/code-quality.md](docs/code-quality.md) explains each stage.

Test expectations, in short (the details are in [docs/code-quality.md](docs/code-quality.md#test-expectations)):

- Cover behavior changes and regressions with focused tests, written against the public boundary and with independent expected values.
- When you change or remove an existing assertion, say which observable requirement it covers and why it changed: a defect, a faulty test, or an intentional requirement change.
- Keep confirmation, refusal, cancellation and recovery cases when moving a feature between components.
- Do not lower coverage floors, add skips or loosen timeouts to make a check pass. Report environment-dependent checks you could not run.
- For substantial functionality or UI changes, also exercise the affected flows in a live browser against the running app. Unit tests alone are not enough there. Follow `DESIGN.md` for UI work.
- Do not add new lint debt. Fix a baselined finding when you work nearby and run `npm run lint:prune`.

Update the docs under `docs/` when you change configuration, behavior or a migration.

## Commits and pull requests

The whole path, from branch to release, is in [docs/workflow.md](docs/workflow.md). In short:

- Work on a branch named `type/topic` (in your fork for outside contributions) and open a pull request against `main`.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(web): improve chat controls`, `fix(server): handle session pagination`, `docs: ...`, `test: ...`, `chore: ...`. Keep each commit focused.
- **The pull request title must be a Conventional Commit header too.** Pull requests are squash-merged, so the title becomes the commit on `main`; the `pr-title` check rejects anything else.
- Explain the problem, the resulting behavior and how you validated it (commands and results) in the pull request. Link the issue, and add screenshots for visible UI changes. The pull request template asks for exactly this.
- Every required check must pass before a pull request is merged. Keep credentials, `.env` files, SQLite databases and `containers/.secrets/` out of commits.
