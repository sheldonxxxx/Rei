# Rei for Android

Rei for Android connects to an existing Rei server. The release APK supports Android 9 (API 28) and newer and requires an HTTPS server URL. The debug build also permits loopback HTTP.

## Navigation

Chat is home: opening the app lands in the last active conversation. A navigation drawer reaches everything else. It lists New chat and history search, **Library**, **Knowledge**, **Background Activity** (with a badge for items that need you), the agents, recent chats, and **Settings**. The drawer adapts to the window width:

| Window width | Drawer |
| --- | --- |
| Under 600dp | Modal. A menu button or an edge swipe opens it over the page. |
| 600dp to 840dp | Dismissible. It opens beside the page, which keeps a readable column of at most 760dp. |
| 840dp and wider | Permanent, beside the page. |

Text follows the system font size, including 200%. Screens, controls and dialogs carry content descriptions for TalkBack.

## Feature coverage

| Area | Android behavior |
| --- | --- |
| Setup and account | Connect to the instance, check protocol compatibility, complete account setup, sign in with password and optional authenticator code, and manage devices. The Android Keystore protects the saved device credential. Configure a signed origin and a matching domain association to use native passkeys. |
| Chat | Agent selection, searchable history, unread state, paging, drafts, sending and stopping, file picker, Library references, live replies, rename/pin/delete, approvals, edit/retry/fork and inline rich results use native controls. The **Show details** toggle in a chat starts from the **Show details by default** setting. The drawer's **+** next to Agents opens a form to name a new agent and choose its avatar. |
| Remote browser | A native full-screen browser panel displays Rei's remote frames and handles touch, dragging, scrolling, keyboard, navigation, modal dialogs and return of control. |
| Library and Knowledge | Search, create and edit pages, upload files, preview and download file versions, manage favorites and restore from Trash. Preview uses bundled Office and PDF renderers. |
| Background Activity | Three segments. **Needs you** holds pending approvals, which use the same approval card as chat, and failed jobs with Retry. **Running** shows queued and running jobs with an indeterminate progress line and elapsed time. **Done** lists trigger reports and memory changes with Undo. A row opens its chat. Pull to refresh, and the lists update live. |
| Settings | A grouped index: an account card, App (Appearance, Notifications, Show details by default, Check for updates), Security (Devices, Passkeys), Rei (General, Memory, Triggers, Usage, Permissions, Providers, Models, Runtime, Connectors, Skills, Plugins) and Session (Sign out of this device and Disconnect server, each behind a confirmation). Every row opens a native screen. Secrets such as provider API keys and connector tokens are written once over the signed-in connection and never shown again. Two sign-in steps open the system browser, because the provider's own page must be used: ChatGPT sign-in for a chat provider and connector sign-in. Plugin and skill export is not in the app: it is a binary download that the web app serves. |
| Notifications | Optional Firebase Cloud Messaging can open the relevant chat and message. The standard build works without a Firebase project. |

## Development tools

Install Git, Node.js 26 or newer, npm, Android Studio, and the Android SDK. Gradle needs JDK 21 or newer. Android Studio's bundled JDK works. Use SDK Manager to install Android SDK Platform 36, Build-Tools 35.0.0 and 36.0.0, Platform-Tools (adb), SDK Command-line Tools, Android Emulator and a system image for your architecture. On Apple silicon select an ARM64 Google APIs image. Create a phone or tablet in Device Manager. Docker and Compose run a local Rei stack. A device with USB debugging can also use adb. The project pins Gradle 9.9, Android Gradle Plugin 9.5 (which compiles Kotlin itself), Kotlin, Compose, AndroidX and the test libraries. Versions live in the Gradle version catalog `gradle/libs.versions.toml`. Release builds run R8 (full mode) with resource shrinking; rules for code reached only by reflection are in `app/proguard-rules.pro`. The app is compiled for Java 17. Each build packages the Office and PDF viewer and Mermaid from the locked npm workspace dependencies, so run `npm ci` before the first build and again after the lockfile changes.

Set JAVA_HOME to JDK 21 or newer, ANDROID_HOME to your SDK, and include the SDK's platform-tools in PATH. JDK 21 and Android Studio's bundled JDK 25 are tested. On macOS the bundled JDK is at `/Applications/Android Studio.app/Contents/jbr/Contents/Home`. In Android Studio, set **Settings → Build, Execution, Deployment → Build Tools → Gradle → Gradle JDK** to the bundled JDK or another JDK 21 or newer, and point the SDK location at the same SDK. Set ANDROID_AVD_HOME and GRADLE_USER_HOME before creating devices or downloading dependencies when using a separate disk.

From the Rei repository root:

```sh
npm ci
cd apps/android
./gradlew assembleDebug testDebugUnitTest lintDebug
adb devices -l
./gradlew connectedDebugAndroidTest
./gradlew installDebug
adb reverse tcp:8787 tcp:8787
```

Open the debug app and enter `http://127.0.0.1:8787` for a Rei instance published on the development computer's loopback port 8787. When several emulators are running, select one with ANDROID_SERIAL or `adb -s SERIAL`. For a release build run `tools/release-apk.sh`, which builds with the version and feed properties below and signs the APK with your release keystore. Keep the same signing identity and raise the version for every upgrade, because Android installs an update only when its versionCode is higher and its signing key is the same. [In-app updates](#in-app-updates) has the details.

[Android Studio installation](https://developer.android.com/studio/install) · [Android SDK paths](https://developer.android.com/tools/variables) · [Rei client contract](../../docs/contract.md) · [Passkey domain and signing setup](../../docs/installation.md#android-passkeys)

## In-app updates

The release APK is sideloaded, so Google Play's update mechanism does not apply. Instead the app reads a small JSON feed that is published with each GitHub Release, downloads the APK it names, checks its SHA-256 and hands it to Android's package installer.

### What the app does

- **Checks.** At launch, at most once a day, and on demand from **Settings → App → Check for updates**, which also shows the installed version. A check is a single GET of the feed URL. Update checks are off when the build has no feed URL, which is the default, so a fork signed with another key never offers this project's builds.
- **Offers.** An update is offered when the feed's `versionCode` is higher than the installed one and its `minSdk` is not above the device's Android version. A dialog shows the new version and its notes; **Later** leaves everything unchanged.
- **Allows installs.** Android lets a sideloaded app install packages only after the person turns on **Install unknown apps** for it. If that is off, the app explains why and opens that Settings page for Rei, then continues when you come back.
- **Downloads and verifies.** The APK streams into the app's cache with a progress banner. If its SHA-256 differs from the feed, the file is deleted and the update stops with an error and **Try again**.
- **Installs.** A `PackageInstaller` session installs it. On Android 12 and newer the app asks for no confirmation, but Android only skips it when this app is allowed to update itself that way, so you may still see the system's **Update** prompt. If Android needs a decision, the app opens it.
- **Outdated app.** When the server answers `426 client_outdated` (see [Versioning](../../docs/contract.md)), the app checks the feed straight away, whatever the daily limit says, and offers the update on the connect screen instead of only telling you to update.

The SHA-256 detects a damaged or swapped download. It does not prove who built the APK, because it comes from the same release as the APK. That job belongs to Android, which refuses an update that is not signed with the installed app's key. Serve the feed and the APK over HTTPS (the app rejects plain HTTP except to loopback).

### Gradle properties

| Property | Meaning | Default |
| --- | --- | --- |
| `reiVersionCode` | Integer `versionCode`. Raise it for every release. | `1` |
| `reiVersionName` | `versionName`, shown in Settings. | `0.1.0` |
| `reiUpdateFeedUrl` | The feed address compiled in as `BuildConfig.UPDATE_FEED_URL`. Empty turns update checks off. | empty |

`tools/release-apk.sh` sets all three for a release. To build with them yourself, pass them with `-P` or put them in your user-level `~/.gradle/gradle.properties` so that they are never committed. For this repository's GitHub Releases the feed address is `https://github.com/<owner>/Rei/releases/latest/download/android-update.json`, where `<owner>` is the account that publishes the releases (see `git remote -v`). Build every release with the same `reiUpdateFeedUrl`, or installed apps stop seeing updates. Do not set it for debug builds, which carry the debug signing key and cannot update a release install.

### Feed format

`android-update.json` is attached to each release:

```json
{
  "versionCode": 2,
  "versionName": "0.2.0",
  "apkUrl": "https://github.com/<owner>/Rei/releases/download/v0.2.0/rei-0.2.0.apk",
  "sha256": "<64 hex characters>",
  "minSdk": 28,
  "notes": "What changed, in a sentence or two."
}
```

Unknown fields are ignored, so the feed can grow. `versionCode` must match the APK, `sha256` is the digest of the exact file at `apkUrl`, and `minSdk` is the lowest Android API level that can run it.

### Publishing a release

Releases are normally made by pushing a version tag: the release workflow builds, signs and verifies the APK with `tools/release-apk.sh`, and attaches `rei-<version>.apk` and `android-update.json` to the GitHub Release. The procedure and the one-time setup (keystore secrets, the `release` environment) are in [Versioning](../../docs/versioning.md).

To build the same signed APK and feed on your own machine, run the script from `apps/android` after `npm ci` at the repository root, with your release keystore described by environment variables (never arguments):

```sh
export ANDROID_KEYSTORE_PATH=/path/to/release.keystore
export ANDROID_KEYSTORE_PASSWORD=...
export ANDROID_KEY_ALIAS=...
export ANDROID_KEY_PASSWORD=...   # optional; defaults to the keystore password
tools/release-apk.sh 0.2.0 https://github.com/<owner>/Rei/releases/latest/download/android-update.json
```

The script takes the version (`X.Y.Z`, without a `v`) and the feed address. It then:

1. Derives `versionCode` as `major × 10000 + minor × 100 + patch` and rejects a version whose minor or patch is 100 or more.
2. Runs `./gradlew assembleRelease` with `-PreiVersionCode`, `-PreiVersionName` and `-PreiUpdateFeedUrl`.
3. Aligns the unsigned APK with `zipalign` and signs it with `apksigner` from the newest installed SDK Build-Tools (36 or newer), aligning to 16 KiB pages (`zipalign -P 16`) for Android 15+ devices and using the v2 and v3 schemes.
4. Runs `apksigner verify`, and fails unless both schemes verify.
5. Writes `build/release/rei-<version>.apk` and `build/release/android-update.json` in the feed format above, with the file's SHA-256, the app's `minSdk` and an `apkUrl` that points at the release asset of the same version (derived from the feed address).

It needs the Android SDK (`ANDROID_HOME`, or `sdk.dir` in `local.properties`), Build-Tools 36 or newer and JDK 21 or newer. The script refuses to run while a local, git-ignored `app/src/firebase/assets/rei-firebase.json` exists, because that file would be bundled into the public APK. Set `REI_ALLOW_LOCAL_FIREBASE=1` if that is intended. Always pass the same feed address for every release, and keep the same keystore, or installed apps stop seeing and accepting updates. To publish by hand instead of through the workflow, upload both files to a GitHub Release. The feed must be an asset named exactly `android-update.json`, and the release must be the latest non-pre-release one, because `releases/latest/download/` resolves to that release:

```sh
gh release create v0.2.0 build/release/rei-0.2.0.apk build/release/android-update.json --title "Rei 0.2.0" --generate-notes
```

Install the first build that has the feed URL by hand (`adb install -r rei-0.2.0.apk`). Installed apps then offer each later release themselves.

## Optional Android push

Register the Android application ID `dev.rei.android` in your own Firebase project and enable the FCM HTTP v1 API. In the ignored file `app/src/firebase/assets/rei-firebase.json`, put the Android client configuration as a JSON object with string keys `appId`, `apiKey`, `projectId` and `senderId`. These correspond to the Firebase mobile SDK app ID, web API key, project ID and numeric project number. Gradle includes Firebase when that file exists. To compile the integration without configuring a project, use `./gradlew -PreiCompileFirebase=true :app:compileDebugKotlin`.

Set `REI_FCM_ENABLED=1` on the control plane and supply `REI_FCM_SERVICE_ACCOUNT_JSON` privately to the gateway. This is the server-side service account for the same Firebase project and requires permission to send FCM messages. Keep the private key on the gateway. Redeploy both services, install the Firebase-configured APK on a Google Play services device, and enable Notifications inside Rei. Test delivery with the app backgrounded, including hidden previews and a tap that opens the exact message. [FCM Android client setup](https://firebase.google.com/docs/cloud-messaging/android/client)
