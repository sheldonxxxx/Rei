# Rei レイ versions and releases

The first release is **v0.0.1**. Rei uses semantic versions: `major.minor.patch`, and a pre-release adds a suffix such as `-rc.1`.

The root `package.json` is the display-version source. The web app reads it to show `Rei v0.0.1` in the browser title and a smaller, muted version beside Rei in the sidebar. The installed app name stays Rei. Workspace packages use the same release number; gateway status reports its package version. The Android app's version is derived from the same number (see [What a release contains](#what-a-release-contains)).

To set a version without creating a Git commit or tag:

```sh
npm version 0.0.2 --workspaces --include-workspace-root --no-git-tag-version
npm run typecheck
npm test
npm run build -w @rei/web
```

Review and commit the updated manifests and lockfile together. Rebuild the web app and deployment images to ship the new version on your own machine.

## Database upgrades

Each release upgrades a database written by **at least the previous minor release** in place, on its first start: `0.3.x` opens a `0.2.x` database, and every patch release opens what the other patches of its minor wrote. Skipping further (from `0.1.x` straight to `0.3.x`) is not promised: upgrade through the releases in between, one minor at a time.

The control plane's SQLite schema carries a number (`SCHEMA_VERSION` in `apps/server/src/db/schema.ts`, with `OLDEST_UPGRADABLE` beside it). On start it:

- creates the schema in an empty data directory;
- upgrades a database from `OLDEST_UPGRADABLE` up to the current number, in one transaction, so a failed upgrade leaves the database as it was;
- refuses, without changing anything, a database older than `OLDEST_UPGRADABLE` or newer than the current number. The control plane stops with a message that says which, and its log shows it (`docker compose … logs control`). For a newer database, run the release that wrote it again; for an older one, step through the releases in between; for either, a backup taken before the upgrade gets you back.

Rei never downgrades a database. Take a backup before an upgrade ([Backup and recovery](storage.md#backup-and-recovery)); `rei upgrade` copies the configuration and secrets in `REI_HOME` for you, but not the data volumes. A release that changes the schema raises `SCHEMA_VERSION`, keeps `OLDEST_UPGRADABLE` no newer than the schema of the previous minor release, and adds a test that upgrades a database of each version it accepts.

## Releasing

A release is a Git tag. Pushing a tag `vX.Y.Z` (or `vX.Y.Z-suffix`) starts [`.github/workflows/release.yml`](../.github/workflows/release.yml), which checks it and then publishes everything without stopping. The tag is the release: only repository admins can push a `v*` tag, so pushing one is the decision to release. Do the [one-time setup](#one-time-setup) first.

1. Start from an up-to-date `main` whose CI is green, and run `npm run verify`.
2. Bump every manifest and the lockfile to the new version:

   ```sh
   npm version 0.2.0 --workspaces --include-workspace-root --no-git-tag-version
   ```

   Every workspace must carry the same version as the root, or the release stops at the version gate.
3. Commit and push `main`, then wait for its CI:

   ```sh
   git commit -am "chore(release): v0.2.0"
   git push origin main
   ```

4. Tag that commit and push the tag. The tag is the release; push no branch with it:

   ```sh
   git tag -a v0.2.0 -m "Rei 0.2.0"
   git push origin v0.2.0
   ```

5. Watch the run under **Actions → Release**. If the `release` environment has required reviewers (see [one-time setup](#one-time-setup)), approve it when it asks ("Review deployments"): once for the images and the Android build together, and once more when the `npm` job starts, before `rei-ai` is published.
6. When the run is green, check the [release page](#what-a-release-contains), and after the first release make each package public (see below).

A pre-release tag, for example `v0.2.0-rc.1`, goes through the same steps, but its GitHub Release is marked as a pre-release, it never becomes the latest release, its images get only their full version tag, with no `X.Y` or `latest`, and `rei-ai` is published under the npm dist-tag `next` (install it with `npm i -g rei-ai@next`), so `npm i rei-ai` keeps the stable release. Bump the manifests to `0.2.0-rc.1` for it.

Never move or reuse a tag. If a release is bad, fix forward with the next patch version. If a run fails part way, use **Re-run failed jobs**: pushing the same images again is harmless. If only the last step fails after the GitHub Release was created, delete that release (not the tag) in the UI and re-run the failed job. A version published to npm cannot be published again, even after `npm unpublish`; if the `npm` job published and something later failed, re-run only the failed jobs, and if the package itself is bad, release the next patch version.

### What the workflow does

| Stage | Jobs | What happens |
| --- | --- | --- |
| Gate | `ci`, `verify-version` | The CI workflow runs as a called workflow. `verify-version` fails unless the tag without the `v` equals the `version` in the root `package.json` and every workspace `package.json` (`scripts/check-release-version.mjs`). |
| Approval | `approve` | Runs in the `release` environment. With no required reviewers it passes at once; with reviewers, nothing is published before one approves it. |
| Images | `web`, `images-build`, `images-merge` | The web app is built once. Each of the six images is then built natively for `linux/amd64` (`ubuntu-24.04`) and `linux/arm64` (`ubuntu-24.04-arm`), with no emulation, and pushed by digest. A merge job per image joins the two into one multi-arch tag, then attests its build provenance. |
| npm | `npm` | Runs in the `release` environment after `images-merge`. `scripts/cli-package.mjs` builds `rei-ai` from the tag: the CLI bundled into one file, and the compose files with every image pinned to the digest `images-merge` just pushed (`image: ghcr.io/<owner>/rei-<name>:X.Y.Z@sha256:…`). It fails unless the version equals the tag and all six images are pinned. The job checks the package, then runs `npm publish --provenance --access public`, with `--tag next` for a pre-release. It publishes by npm trusted publishing: npm exchanges the job's OIDC token (`id-token: write`) for a one-time credential, so there is no npm token anywhere. |
| Android | `android` | Runs `apps/android/tools/release-apk.sh` with the signing key from the `release` environment's secrets, then uploads the APK and the update feed. |
| Release | `release` | Waits for every job above, then creates the GitHub Release with `gh release create --generate-notes --verify-tag`, attaches the APK and `android-update.json`, and lists the image references and digests in the notes. |

The CI workflow skips its own Android and image builds on a tag, because the release builds the real ones.

### What a release contains

- **Images**, public once you have set them so, at `ghcr.io/<owner>/rei-<name>` for `control`, `gateway`, `reader`, `egress`, `exec` and `browser` (`<owner>` is the lowercased repository owner). Tags: `X.Y.Z`, and for a stable release also `X.Y` and `latest`. Each image carries OCI labels (source, license MIT, version), a max-mode provenance record, an SBOM and a signed build provenance attestation. Check one:

  ```sh
  gh attestation verify oci://ghcr.io/<owner>/rei-control:0.2.0 --repo <owner>/Rei
  ```

- **The Android APK** `rei-X.Y.Z.apk`, signed with the release key (v2 and v3 schemes), and the feed `android-update.json` that the app's in-app updater reads from the latest release (see [In-app updates](../apps/android/README.md#in-app-updates)). The `versionCode` is `major × 10000 + minor × 100 + patch`, so `0.2.0` is `200` and `1.4.12` is `10412`. Minor and patch must stay below 100; the script and the workflow refuse a version that does not fit. A pre-release has the same `versionCode` as its final release, so an `-rc` APK installed by hand is not offered the final build by the app. Install the final one over it with `adb install -r`.
- **The npm package** [`rei-ai`](https://www.npmjs.com/package/rei-ai) at version `X.Y.Z`, with a provenance statement linking it to this workflow run (shown on its npm page; `npm audit signatures` checks it). It has no runtime dependencies and carries the compose files that pin the release's images by digest.
- **The GitHub Release**, with generated notes, the install command, the image table and both Android files.

## One-time setup

Do this once, in this order. `<owner>` is the account or organization that owns the repository.

1. **Create the `release` environment.** Repository **Settings → Environments → New environment**, named exactly `release`.
   - **Required reviewers** are optional. Without them a tag push releases straight through, and the tag rules (only admins may create, move or delete `v*` tags) and the tag-only environment are what guard a release. With them, every release stops twice for a reviewer: before anything is published, and again before the npm publish, the one step whose version can never be reused. If you are the only reviewer, leave **Prevent self-review** off, or you could not approve your own release.
   - Under **Deployment branches and tags**, choose **Selected branches and tags** and add the tag rule `v*`, so only a version tag can use the environment and its secrets.

2. **Store the signing key as secrets of that environment** (**Environments → release → Add environment secret**, or with `gh`). Use the same release keystore that signed earlier builds: Android installs an update only when the signing key matches the installed app's. Encode the keystore file as one line of base64 and paste it as the value:

   ```sh
   # macOS
   base64 -i release.keystore | tr -d '\n' | gh secret set ANDROID_KEYSTORE_B64 --env release
   # Linux
   base64 -w0 release.keystore | gh secret set ANDROID_KEYSTORE_B64 --env release
   ```

   Then add the other three. `gh secret set` asks for the value without echoing it, so it stays out of your shell history:

   ```sh
   gh secret set ANDROID_KEYSTORE_PASSWORD --env release
   gh secret set ANDROID_KEY_ALIAS --env release
   gh secret set ANDROID_KEY_PASSWORD --env release
   ```

   | Secret | Value |
   | --- | --- |
   | `ANDROID_KEYSTORE_B64` | The keystore file, base64 on one line |
   | `ANDROID_KEYSTORE_PASSWORD` | The keystore password |
   | `ANDROID_KEY_ALIAS` | The key alias inside the keystore |
   | `ANDROID_KEY_PASSWORD` | The key password (the same as the keystore password if you set no other) |

   Keep an offline backup of the keystore and its passwords. Losing the key means installed apps can never update; they must be uninstalled first.

3. **Let npm trust the workflow.** Do this before the first tag: without it the `npm` job fails, and the GitHub Release, which waits for it, is not created.
   1. Publish a placeholder by hand once, because a trusted publisher can only be added to a package that exists. From an empty folder, signed in to npm (`npm login`), with a `package.json` of `{"name": "rei-ai", "version": "0.0.0", "description": "Placeholder; install a later version.", "license": "MIT"}`, run `npm publish --access public`. Then run `npm deprecate rei-ai@0.0.0 "Placeholder. Install rei-ai@latest."`. The nightly workflow ignores `0.0.0`.
   2. On npmjs.com open **rei-ai → Settings → Trusted publishing**, choose **GitHub Actions**, and enter organization or user `<owner>`, repository `Rei`, workflow filename `release.yml` and environment `release`. Save.
   3. Optionally, under **Settings → Publishing access**, choose **Require two-factor authentication and disallow tokens**: trusted publishing keeps working, and no token can publish.

   The package's `repository` field (written by `scripts/cli-package.mjs`) must name this repository, or npm refuses the provenance. If the repository moves, update the field in the script and the trusted publisher together.

4. **Push the first release tag** as described above (and approve it twice if you set required reviewers).

5. **Make each package public.** New packages on GitHub's registry start **private**, even in a public repository, so nobody else can pull them until you change that. After the first run, open **your profile → Packages** (or `https://github.com/orgs/<owner>/packages` for an organization) and for each of `rei-control`, `rei-gateway`, `rei-reader`, `rei-egress`, `rei-exec` and `rei-browser`: open it, then **Package settings → Danger Zone → Change visibility → Public**. Check from a machine that is not signed in to the registry:

   ```sh
   docker logout ghcr.io
   docker pull ghcr.io/<owner>/rei-control:<version>
   ```

   Later releases keep the visibility you set. The workflow can write to these packages because it created them from this repository. Until they are public, `npx rei-ai setup` fails at pulling the images for everyone but you.

Optional, and not required by the workflow: a tag ruleset (**Settings → Rules → Rulesets → New tag ruleset**, target `v*`) that restricts who can create, move or delete version tags, and branch protection on `main` that requires the CI checks.

## Building the Android APK by hand

`apps/android/tools/release-apk.sh` does what the `android` job does, for a maintainer's machine. See [Publishing a release](../apps/android/README.md#publishing-a-release).
