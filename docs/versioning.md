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

## Releasing

A release is a Git tag. Pushing a tag `vX.Y.Z` (or `vX.Y.Z-suffix`) starts [`.github/workflows/release.yml`](../.github/workflows/release.yml), which checks it, waits for one approval, then publishes everything. Do the [one-time setup](#one-time-setup) first.

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

5. Open the run under **Actions → Release** and approve the **release** environment when it asks ("Review deployments"). One approval covers the whole release: the approval job and the Android job wait for it together, and everything that publishes runs after it.
6. When the run is green, check the [release page](#what-a-release-contains), and after the first release make each package public (see below).

A pre-release tag, for example `v0.2.0-rc.1`, goes through the same steps, but its GitHub Release is marked as a pre-release, it never becomes the latest release, and its images get only their full version tag, with no `X.Y` or `latest`. Bump the manifests to `0.2.0-rc.1` for it.

Never move or reuse a tag. If a release is bad, fix forward with the next patch version. If a run fails part way, use **Re-run failed jobs**: pushing the same images again is harmless. If only the last step fails after the GitHub Release was created, delete that release (not the tag) in the UI and re-run the failed job.

### What the workflow does

| Stage | Jobs | What happens |
| --- | --- | --- |
| Gate | `ci`, `verify-version` | The CI workflow runs as a called workflow. `verify-version` fails unless the tag without the `v` equals the `version` in the root `package.json` and every workspace `package.json` (`scripts/check-release-version.mjs`). |
| Approval | `approve` | Runs in the `release` environment, so a reviewer must approve it. Nothing is published before this. |
| Images | `web`, `images-build`, `images-merge` | The web app is built once. Each of the six images is then built natively for `linux/amd64` (`ubuntu-24.04`) and `linux/arm64` (`ubuntu-24.04-arm`), with no emulation, and pushed by digest. A merge job per image joins the two into one multi-arch tag, then attests its build provenance. |
| Android | `android` | Runs `apps/android/tools/release-apk.sh` with the signing key from the `release` environment's secrets, then uploads the APK and the update feed. |
| Release | `release` | Creates the GitHub Release with `gh release create --generate-notes --verify-tag`, attaches the APK and `android-update.json`, and lists the image references and digests in the notes. |

The CI workflow skips its own Android and image builds on a tag, because the release builds the real ones.

### What a release contains

- **Images**, public once you have set them so, at `ghcr.io/<owner>/rei-<name>` for `control`, `gateway`, `reader`, `egress`, `exec` and `browser` (`<owner>` is the lowercased repository owner). Tags: `X.Y.Z`, and for a stable release also `X.Y` and `latest`. Each image carries OCI labels (source, license MIT, version), a max-mode provenance record, an SBOM and a signed build provenance attestation. Check one:

  ```sh
  gh attestation verify oci://ghcr.io/<owner>/rei-control:0.2.0 --repo <owner>/Rei
  ```

- **The Android APK** `rei-X.Y.Z.apk`, signed with the release key (v2 and v3 schemes), and the feed `android-update.json` that the app's in-app updater reads from the latest release (see [In-app updates](../apps/android/README.md#in-app-updates)). The `versionCode` is `major × 10000 + minor × 100 + patch`, so `0.2.0` is `200` and `1.4.12` is `10412`. Minor and patch must stay below 100; the script and the workflow refuse a version that does not fit. A pre-release has the same `versionCode` as its final release, so an `-rc` APK installed by hand is not offered the final build by the app. Install the final one over it with `adb install -r`.
- **The GitHub Release**, with generated notes, the image table and both Android files.

## One-time setup

Do this once, in this order. `<owner>` is the account or organization that owns the repository.

1. **Create the `release` environment.** Repository **Settings → Environments → New environment**, named exactly `release`.
   - Turn on **Required reviewers** and add yourself or the people who may approve a release. If you are the only reviewer, leave **Prevent self-review** off, or you could not approve your own release.
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

3. **Push the first release tag** as described above and approve it.

4. **Make each package public.** New packages on GitHub's registry start **private**, even in a public repository, so nobody else can pull them until you change that. After the first run, open **your profile → Packages** (or `https://github.com/orgs/<owner>/packages` for an organization) and for each of `rei-control`, `rei-gateway`, `rei-reader`, `rei-egress`, `rei-exec` and `rei-browser`: open it, then **Package settings → Danger Zone → Change visibility → Public**. Check from a machine that is not signed in to the registry:

   ```sh
   docker logout ghcr.io
   docker pull ghcr.io/<owner>/rei-control:<version>
   ```

   Later releases keep the visibility you set. The workflow can write to these packages because it created them from this repository.

Optional, and not required by the workflow: a tag ruleset (**Settings → Rules → Rulesets → New tag ruleset**, target `v*`) that restricts who can create, move or delete version tags, and branch protection on `main` that requires the CI checks.

## Building the Android APK by hand

`apps/android/tools/release-apk.sh` does what the `android` job does, for a maintainer's machine. See [Publishing a release](../apps/android/README.md#publishing-a-release).
