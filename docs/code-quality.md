# Local code quality

Rei uses pinned tools from the root npm workspace. Node.js 24 or newer is required. Install with `npm ci`; the `prepare` script installs the local Husky hook. Environments without Git or development dependencies can use `HUSKY=0 npm ci` (container production installs already use `--ignore-scripts`).

Run `npm run verify` before handing off a change. It checks formatting/imports, lint regressions, strict TypeScript, architecture, dependency declarations, secrets, every Vitest project with coverage floors, and the production web build. It makes no deployments or Git commits. It is `npm run check:static` (the checks that need no test run), then `npm run test:coverage`, then `npm run build`. GitHub Actions runs the same scripts; see [Continuous integration](#continuous-integration).

| Command                      | Purpose                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------- |
| `npm run check:static`       | Run every static check in order: format, lint, contract, types, architecture, dependencies, secrets |
| `npm run format`             | Apply the repository's two-space, double-quote, semicolon, LF formatting          |
| `npm run format:check`       | Check formatting and import organization without modifying files                  |
| `npm run lint`               | Fail on new Biome recommended warnings/errors                                     |
| `npm run lint:report`        | Show the entire remaining lint backlog; exits nonzero while errors remain         |
| `npm run lint:prune`         | Remove resolved findings from the baseline; cannot accept new findings            |
| `npm run lint:promises`      | Optional trial of Biome's experimental promise rules; findings need manual review |
| `npm run check:architecture` | Check imports across workspaces and platform boundaries                           |
| `npm run check:dependencies` | Check unused/missing dependency declarations and unresolved imports with Knip     |
| `npm run check:secrets`      | Scan source, tests, scripts, and documentation for credentials                    |
| `npm run check:security`     | Query npm advisories, including development dependencies; requires network access |
| `npm run test:coverage`      | Run all tests with V8 coverage and write HTML/JSON reports under `coverage/`      |
| `npm run build`              | Build the web workspace; Node services execute TypeScript directly                |

`verify` is offline apart from dependencies already installed; the network advisory check is separate. Integration tests need permission to bind loopback ports/unix sockets and spawn processes. Run tests in a normal local shell when an agent sandbox prevents these operations. Do not turn failing tests into skipped tests to work around that sandbox.

## Formatting and lint adoption

Biome formats maintained source/configuration files and organizes imports. Generated assets, lockfiles, binary test fixtures, the frozen web pages of the web-reading eval (deliberately malformed HTML), local benchmark output in `.local/`, and vendored styles are excluded. `.editorconfig` keeps editor output consistent. Avoid formatting unrelated files during ordinary follow-up work; this setup includes the initial repository-wide formatting migration.

Lint has a narrower scope than formatting: `.agents/skills/` is excluded from Biome lint because it contains installed agent guidance. Formatting checks still use the `files.includes` scope above.

The recommended lint preset exposed existing accessibility, React dependency, type-escape, and legacy idiom findings. They are recorded explicitly in `lint-baseline.json`, rather than disabling those rules globally or automatically rewriting application behavior. Baseline entries bind a path, rule, message, surrounding source, and maximum occurrence count. Line-number shifts are allowed; changed code, a different file, or an additional occurrence fails. Parser/configuration failures are never exempted. Informational style suggestions do not fail the gate.

Fix a baselined finding when working in its area, run `npm run lint:prune`, and include the reduced baseline with the change. There is intentionally no command that accepts new debt. Use a narrow inline `biome-ignore` with a concrete reason for a real false positive. The baseline is technical debt, not a claim that the codebase has no lint findings. Security-sensitive and behavior-changing cleanup should receive focused tests and browser verification where applicable.

`noNonNullAssertion` is intentionally off: the existing strict TypeScript code uses explicit assertions for checked array/map lookups and test fixtures, alongside `noUncheckedIndexedAccess`. Other recommended rules remain enabled. The promise rules are an optional audit until their experimental analysis has been reviewed against the scheduler/session lifecycle.

The lint baseline is tested to reject new/changed/duplicate findings and parser errors. Architecture tests inject forbidden imports and verify the command exits unsuccessfully. The secret-scanner test verifies that an additional synthetic token in a test file fails.

## Architecture and dependency checks

Applications communicate through `@rei/protocol`; imports into another application's internals fail. The gateway core and server domain cannot import `src/node` adapters. Web code cannot import Node built-ins. Production source cannot import tests or evaluation helpers. Type-only dependencies are included in the checks. TypeScript remains the authority for detailed type/module resolution.

The CLI has no grandfathered cross-workspace import: its former embedding setup, which imported `apps/server/src/memory/embedder.ts`, was removed. `vite/client` is a declaration-only TypeScript reference handled by the compiler.

Knip's mandatory gate focuses on dependency declarations rather than pruning intentionally exported contracts or unused UI primitives. `npx knip` is available for a broader manual dead-code review. The Secretlint preset is loaded by `.secretlintrc.json`, so Knip explicitly allows that configuration dependency. An absolute import inside the deployed-image test's remote `node -e` script is resolved in its container, not on the host, and has an exact Knip exception.

## Hooks and secrets

The pre-commit hook runs lint-staged serially: format/organize staged code, check lint regressions, then scan every staged file type for secrets. lint-staged handles partially staged files and restores its temporary changes on failure. It does not run the full test suite on every commit. Use `npm run verify` before review.

Secretlint uses the recommended preset. Two exact synthetic fixture values used by security regression tests are allowed, with no blanket exclusion for test files or documentation. Local `.env`/backup files, deployment secrets, generated files and dependencies remain outside source scanning and Git. This scans current files, not historical commits. Never use `--no-maskSecrets` when collecting evidence.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request. It never uses `pull_request_target`, needs no secrets, and gives every job a read-only token (`permissions: contents: read`). Actions are pinned by full commit SHA with the version in a comment, a `concurrency` group cancels superseded runs, and every job has a timeout. Node.js comes from `.nvmrc` (24), with the npm cache.

| Job      | What it runs                                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static` | A pinned gitleaks scan of the tree, then `npm ci` and `npm run check:static`                                                                         |
| `test`   | `npm run test:coverage`; `coverage/` is uploaded as an artifact                                                                                      |
| `web`    | `npm run build`                                                                                                                                      |
| `android`| `./gradlew assembleDebug testDebugUnitTest lintDebug` with JDK 21 and a Gradle cache, only when `apps/android/**`, `apps/web/src/**`, `package-lock.json` or the workflow changed |
| `images` | `docker build` of `containers/{control,gateway,reader,egress,exec}` (repository root as context) and `containers/browser`, with the GitHub Actions layer cache and no push, only when `apps/**`, `packages/**`, `containers/**`, `package-lock.json` or the workflow changed |

`android` and `images` always run and report a result: a filter step (`dorny/paths-filter`, using git rather than the API, so no extra permission) decides whether the build steps run. A skipped build is a green check, so either job can be a required status check.

CI covers what `npm run verify` covers, plus the Android and image builds, on a clean checkout on Linux. It does not run the opt-in suites (real Chromium, LibreOffice, the embedder evaluation, the runtime benchmark), `npm run check:security`, live-browser flows or any provider-specific check. A green run does not mean the app was deployed.

`.github/dependabot.yml` opens weekly update pull requests, with minor and patch updates grouped per ecosystem: npm (root), GitHub Actions, Gradle (`apps/android`) and Docker (each `containers/*` Dockerfile directory). Major updates arrive separately. Dependabot's pull requests go through the same CI.

To change a pinned action, update the SHA and the version comment together. To update the pinned gitleaks release, change `GITLEAKS_VERSION` and `GITLEAKS_SHA256` in the workflow; the checksum comes from the release's checksums file.

`ci.yml` is also callable (`workflow_call`): the release workflow runs it first. When called for a tag, it skips its own `android` and `images` jobs, because the release builds the real ones. Releases are described in [Versioning](versioning.md#releasing). Branch protection and a tag ruleset are repository settings and later work, not part of this workflow.

## Dependencies and UI assets

All quality tools are exact root development dependencies. The unused shadcn scaffolding CLI was removed; its static stylesheet from `shadcn@4.23.0` is preserved under `apps/web/src/styles/vendor/`, with its MIT license, so the UI does not need the CLI dependency tree at build/runtime. Update the stylesheet and license together when deliberately updating that upstream asset. The CLI tests now declare their YAML dependency directly.

## Test expectations

When changing or removing an existing assertion, name the observable requirement and explain the reason: an implementation defect, an incorrect test/fixture, or an intentional requirement change. Keep the requirement fixed when correcting the implementation. Correct a test only with evidence for its faulty assumption; the current output alone is insufficient justification.

Preserve confirmation, refusal, cancellation and recovery cases when moving a feature between components. Assert behavior through the public boundary, using independent literals, standard vectors or worked examples for expected results. Round trips and values derived with production helpers supplement that evidence; they cannot establish interoperability on their own.

For important new regression checks, demonstrate that a relevant deliberate fault fails the named assertion in an isolated copy, then restore correct code and verify it passes. Keep test files unchanged during the fault experiment. Record that evidence when adding the regression or materially changing its contract; routine implementation edits do not require rewriting tests or rerunning every fault experiment.

Prefer required output rows and observable states over incidental line totals, helper-call counts or transport chunk boundaries. Keep operational budgets in explicitly named budget tests when they are requirements. Use controlled clocks and release gates for timing-dependent behavior, with timeouts serving only as deadlock guards. Preserve coverage floors and report environment-dependent skips explicitly.

## Coverage and release checks

Coverage includes maintained application TypeScript, including files a test never imports, and excludes test helpers, declarations, and executable entry points exercised by subprocess tests. Reports are local ignored output. Critical-path coverage floors are configured in the root Vitest configuration from the measured suite. Overall minimums are 80% statements, 75% branches, 80% functions, and 85% lines, with higher file-specific floors for policy decisions, authentication, policy guards, scheduling, and session lifecycle/recovery. Raise these as behavior tests are added. Child-process code is validated by the integration suite but its execution is not attributed to the parent's V8 report.

Before a production release, also review `npm run check:security`, live-browser flows, provider-specific integration tests, and the installation/backup/restore procedures for the target deployment. A passing local quality gate is evidence of code quality, not proof of operational readiness on every host. Deployments are not automated. The CI workflow described below builds and tests but publishes nothing; publishing is the separate tag-driven release workflow in [Versioning](versioning.md#releasing).

Tool references: [Biome configuration](https://biomejs.dev/reference/configuration/), [Knip workspaces](https://knip.dev/features/monorepos-and-workspaces), [dependency-cruiser rules](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md), [Vitest coverage](https://vitest.dev/config/coverage), and [Secretlint](https://github.com/secretlint/secretlint).
