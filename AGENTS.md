# Rei レイ — Repository Guidelines

## Project Direction

Build an inspectable AI agent/bot platform. Simple mode prioritizes clean UI/UX; detail mode gives users maximum traceability into AI behavior. Prioritize helping users understand and improve agent behavior. Keep security proportionate to that goal.

## Project Structure & Module Organization

This repository is a private npm workspace monorepo using TypeScript and ES modules.

- `apps/server`: Hono control plane, SQLite persistence, agent runtime, memory, and file library; backend tests live in `test/` and `eval/`.
- `apps/web`: React/Vite frontend; components, state, and colocated tests live in `src/`, and static assets in `public/`.
- `apps/gateway`, `apps/egress`, and `apps/cli`: model gateway, network proxy, and onboarding CLI.
- `packages/protocol`: shared API contracts and entity types. Update these alongside producers and consumers.
- `tests/e2e`: integration scenarios and fixtures; `containers/`: deployment infrastructure; `docs/`: architecture and validation evidence.

## Build, Test, and Development Commands

Use Node.js 24 or newer. Run commands from the repository root:

- `npm ci`: install locked workspace dependencies and the local pre-commit hook.
- `npm run verify`: run local quality gates, all tests, and the production web build (no deployment). It is `npm run check:static && npm run test:coverage && npm run build`.
- `npm run check:static`: run only the static checks (format, lint, contract, types, architecture, dependencies, secrets).
- `npm run format`: format maintained source/configuration files with Biome.
- `npm run lint`: reject new Biome findings against the explicit adoption baseline.
- `npm run test:coverage`: generate V8 coverage and enforce critical-path floors.
- `npm run check:security`: query npm advisories, including dev dependencies.
- `npm run typecheck`: check all workspaces with TypeScript.
- `npm test`: run all configured Vitest projects.
- `npx vitest list --filesOnly`: list discovered test files by project.
- `npx vitest run --project server`: run one project. Add a test file path to narrow the run further.
- `npm run dev -w @rei/web`: start Vite on port 5173; API requests proxy to localhost:8787 by default.
- `REI_MODEL_MODE=faux npm start -w @rei/server`: start the server with the simulated model for local development.
- `npm run build -w @rei/web`: produce frontend assets in `apps/web/dist/`.

## Coding Style & Naming Conventions

Follow surrounding code: two-space indentation, double quotes, and semicolons. TypeScript uses strict checks, including `noUncheckedIndexedAccess`. Use explicit type imports and `.ts`/`.tsx` extensions for relative imports. Prefer PascalCase React component files and kebab-case service modules. Reuse frontend primitives in `apps/web/src/components/primitives/`. Follow `DESIGN.md` for UI work (for example, prefer icon buttons to text buttons). Biome enforces formatting and import order; see `docs/code-quality.md` for lint adoption, architecture rules, dependency checks, and hooks. Avoid unrelated formatting changes.

## Testing Guidelines

Use Vitest; frontend tests use Testing Library with happy-dom. Name tests `*.test.ts` or `*.test.tsx`. Cover behavior changes and regressions with focused tests, then run relevant projects and typechecking. Critical-path coverage floors are defined in the root Vitest config; do not lower them to make a change pass. Record skipped environment-dependent checks and their prerequisites explicitly.

For substantial functionality or UI changes, also run end-to-end tests in a live browser against the running application. Exercise affected user flows and verify visible behavior; record results and screenshots where useful. Unit tests alone are insufficient for these changes.

### Pre-commit and test suite

The Husky pre-commit hook formats staged code, checks lint regressions, and scans staged files for secrets. Run `npm run verify` separately before handoff. Read [Local code quality](docs/code-quality.md) for the verification stages, hook behavior, and coverage floors.

- `server` covers API, auth, runtime, tools, persistence, recovery, and evaluations in `apps/server/test/` and `apps/server/eval/`. Real Chromium, LibreOffice, the embedder evaluation, and the runtime benchmark require explicit opt-in.
- `web` covers components, interactions, state, and streaming in `apps/web/src/`.
- `gateway`, `reader`, `egress`, and `cli` cover model routing, web reading, proxy behavior, and local operations in their respective `apps/*/test/` directories.
- `logging` and `@rei/network` cover shared helpers in `packages/`. `quality` exercises the repository's quality tools in `tests/quality/`. `e2e` owns cross-component scenarios in `tests/e2e/`.

When subprocess or local socket tests time out in a sandbox, rerun the same files in a normal local shell with permission to spawn child processes and bind loopback and Unix sockets. The `server` and `e2e` projects default to 40- and 60-second test and hook limits respectively. For the gateway round trips, run `npx vitest run --project e2e tests/e2e/gateway-roundtrip.test.ts`. Those cases use a real Rei server subprocess, the real gateway, and a fake upstream on loopback. If the focused host run passes, rerun `npm run verify` there and report the result. If the failure reproduces, use the first error to identify whether it occurred during startup, an assertion, or teardown. Preserve test timeouts and coverage floors when working around sandbox restrictions.

## Production Readiness Standard

Treat production readiness as evidence across code, user behavior, security, and operations. Before handing off a change, run `npm run verify` and report its result. For a production release, also review `npm run check:security`, exercise affected flows in a live browser, run provider-specific integration checks where applicable, and verify installation, backup, and restore procedures for the target deployment. Record skipped checks and their prerequisites; do not lower coverage floors or add skips to make a gate pass.

A passing local quality gate establishes local code and build validation only. It does not establish production readiness on every host, prove real-provider behavior, or mean the app was deployed. State which release checks were actually performed and keep deployment claims separate from local validation.

## Early Development Deployment and End-to-End Testing

This project is still in early development. Deploy and test against a local Docker stack on the developer's own machine. After substantial changes, rebuild and redeploy that stack and run full end-to-end tests in a live browser using the saved development login. This workflow is already authorized for the agent working on this repository: do not ask for additional approval for the redeployment, setup, or testing. Preserve existing app data on routine redeployments; reset volumes only when the user requests a fresh stack. Keep the app bound to loopback and leave unrelated services alone.

Store the development login in `containers/.secrets/dev-login.json` (mode `0600`, ignored by Git). Reuse it for login and end-to-end tests; if a fresh stack needs setup, save the newly generated password there. Never put passwords, API keys, or session cookies in source files, test reports, screenshots, or commits. Record the deployed version, tested flows, results, and any environment-dependent gaps.

Machine-specific details of a maintainer's setup (hosts, paths, other services) belong in that maintainer's own notes, not in this repository.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests with a read-only token and no secrets: `static` (gitleaks and `npm run check:static`), `test` (`npm run test:coverage`), `web` (`npm run build`), `android` (Gradle debug build, unit tests and lint, only for Android-related changes) and `images` (Docker builds of every Compose image, no push, only for image-related changes). It runs the same scripts as `npm run verify`, so a green local `verify` should predict a green run. Keep it that way: add a check as an npm script and call it from the workflow rather than inlining commands. Pin new actions by full commit SHA with the version in a comment, and never use `pull_request_target`. `.github/dependabot.yml` opens weekly grouped update pull requests. See `docs/code-quality.md`.

`.github/workflows/release.yml` runs when a tag `vX.Y.Z` is pushed: it calls `ci.yml`, checks that the tag equals every `package.json` version, passes the `release` environment (which waits for approval only if it has required reviewers), then publishes multi-arch images to GHCR, the signed Android APK and a GitHub Release. Do not push a tag unless the owner asks. The procedure and the owner's one-time setup are in `docs/versioning.md`.

## Commit & Pull Request Guidelines

Follow the Conventional Commits style in history, for example `feat(web): improve chat controls` or `fix(server): handle session pagination`. Keep commits focused. PR descriptions should explain the problem, resulting behavior, and validation commands/results; link relevant issues and include screenshots for visible UI changes. Document configuration or migration changes in `docs/`.

## Security & Configuration

Keep credentials, `.env` files, SQLite databases, and `containers/.secrets/` out of commits. Server configuration lives in `apps/server/src/node/config.ts`; real model mode requires `GATEWAY_URL`. Local command execution is permitted only with faux model mode; preserve this guard.

## Agent skills

### Issue tracker

Issues and specs live as Markdown files under `.scratch/` (local and git-ignored). See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context layout. See `docs/agents/domain.md`.
