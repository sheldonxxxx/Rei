#!/usr/bin/env bash
# Build, sign and describe a release APK. CI and a maintainer's own machine run this same script.
#
#   tools/release-apk.sh <version> <feed-url> [out-dir]
#
#   version    X.Y.Z or X.Y.Z-suffix, without a leading "v". versionCode = major*10000 + minor*100 + patch,
#              so minor and patch must stay below 100.
#   feed-url   The update feed address compiled into the app, which must be
#              https://github.com/<owner>/<repo>/releases/latest/download/android-update.json
#              The APK address in the feed is derived from it.
#   out-dir    Where the results go (default: apps/android/build/release). It receives
#              rei-<version>.apk and android-update.json.
#
# The signing key comes from the environment, never from arguments (so it stays out of process listings and logs):
#
#   ANDROID_KEYSTORE_PATH       path to the release keystore
#   ANDROID_KEYSTORE_PASSWORD   keystore password
#   ANDROID_KEY_ALIAS           key alias in that keystore
#   ANDROID_KEY_PASSWORD        key password (defaults to the keystore password)
#
# Optional: REI_RELEASE_NOTES (the feed's notes text), ANDROID_HOME or ANDROID_SDK_ROOT (otherwise sdk.dir from
# local.properties), JAVA_HOME (JDK 21 or newer).
#
# Needs Node.js (to write the feed) and Android SDK Build-Tools 36 (zipalign, apksigner). Run `npm ci` at the
# repository root first, because the app packages the web client's viewer from node_modules.
set -euo pipefail

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }
die() { printf 'release-apk: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

case "${1:-}" in -h | --help) usage; exit 0 ;; esac
[ "$#" -ge 2 ] && [ "$#" -le 3 ] || { usage >&2; exit 2; }

VERSION=$1
FEED_URL=$2
ANDROID_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR=${3:-$ANDROID_DIR/build/release}

# --- Version ---------------------------------------------------------------------------------------------------
version_re='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$'
[[ $VERSION =~ $version_re ]] || die "version \"$VERSION\" is not X.Y.Z or X.Y.Z-suffix (no leading v)."
major=${BASH_REMATCH[1]} minor=${BASH_REMATCH[2]} patch=${BASH_REMATCH[3]}
# Check the length first so that the arithmetic below can never overflow.
[ "${#major}" -le 6 ] && [ "${#minor}" -le 2 ] && [ "${#patch}" -le 2 ] \
  || die "version $VERSION does not fit versionCode = major*10000 + minor*100 + patch (minor and patch below 100, major at most 210000)."
VERSION_CODE=$((major * 10000 + minor * 100 + patch))
[ "$VERSION_CODE" -ge 1 ] && [ "$VERSION_CODE" -le 2100000000 ] \
  || die "version $VERSION gives versionCode $VERSION_CODE, outside 1..2100000000."

# --- Feed URL --------------------------------------------------------------------------------------------------
feed_suffix='/releases/latest/download/android-update.json'
[[ $FEED_URL == https://*"$feed_suffix" ]] || die "feed URL must be https://<host>/<owner>/<repo>${feed_suffix}"
APK_URL="${FEED_URL%"$feed_suffix"}/releases/download/v${VERSION}/rei-${VERSION}.apk"

# --- Signing key -----------------------------------------------------------------------------------------------
for name in ANDROID_KEYSTORE_PATH ANDROID_KEYSTORE_PASSWORD ANDROID_KEY_ALIAS; do
  [ -n "${!name:-}" ] || die "$name is not set."
done
[ -f "$ANDROID_KEYSTORE_PATH" ] || die "ANDROID_KEYSTORE_PATH does not name a file."
export ANDROID_KEY_PASSWORD="${ANDROID_KEY_PASSWORD:-$ANDROID_KEYSTORE_PASSWORD}"

# --- Toolchain -------------------------------------------------------------------------------------------------
if [ -z "${ANDROID_HOME:-}" ]; then
  ANDROID_HOME="${ANDROID_SDK_ROOT:-}"
fi
if [ -z "$ANDROID_HOME" ] && [ -f "$ANDROID_DIR/local.properties" ]; then
  ANDROID_HOME=$(sed -n 's/^sdk\.dir=//p' "$ANDROID_DIR/local.properties" | head -n 1)
fi
[ -d "${ANDROID_HOME:-}" ] || die "Android SDK not found. Set ANDROID_HOME (or ANDROID_SDK_ROOT)."
export ANDROID_HOME
if [ -z "${JAVA_HOME:-}" ] && [ "$(uname -s)" = Darwin ] \
  && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
[ -z "${JAVA_HOME:-}" ] || export PATH="$JAVA_HOME/bin:$PATH"
command -v java >/dev/null || die "Java not found. Install JDK 21 or newer and set JAVA_HOME."
command -v node >/dev/null || die "Node.js not found."

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

# --- Build -----------------------------------------------------------------------------------------------------
say "Building the unsigned release APK $VERSION (versionCode $VERSION_CODE)"
cd "$ANDROID_DIR"
# Gradle (and the build scripts of its dependencies) never need the signing secrets, so it does not get them.
env -u ANDROID_KEYSTORE_PASSWORD -u ANDROID_KEY_PASSWORD -u ANDROID_KEY_ALIAS -u ANDROID_KEYSTORE_PATH \
  ./gradlew assembleRelease --console=plain \
  "-PreiVersionCode=$VERSION_CODE" "-PreiVersionName=$VERSION" "-PreiUpdateFeedUrl=$FEED_URL"
UNSIGNED="$ANDROID_DIR/app/build/outputs/apk/release/app-release-unsigned.apk"
[ -f "$UNSIGNED" ] || die "Gradle did not produce $UNSIGNED."

# Build-Tools 36 can be installed by Gradle during the build, so look for it only now.
BUILD_TOOLS=
for dir in "$ANDROID_HOME"/build-tools/36.*; do
  [ -x "$dir/apksigner" ] && BUILD_TOOLS=$dir
done
[ -n "$BUILD_TOOLS" ] || die "Android SDK Build-Tools 36 not found under $ANDROID_HOME/build-tools (sdkmanager \"build-tools;36.0.0\")."

# The app's own minSdk, read from the Gradle file so that the signature check and the feed cannot drift from it.
MIN_SDK=$(sed -n 's/^[[:space:]]*minSdk = \([0-9][0-9]*\)$/\1/p' "$ANDROID_DIR/app/build.gradle.kts" | head -n 1)
[ -n "$MIN_SDK" ] || die "could not read minSdk from app/build.gradle.kts."

# --- Align, sign, verify ---------------------------------------------------------------------------------------
say "Aligning and signing with $(basename "$BUILD_TOOLS")"
"$BUILD_TOOLS/zipalign" -p -f 4 "$UNSIGNED" "$WORK_DIR/aligned.apk"
"$BUILD_TOOLS/zipalign" -c -p 4 "$WORK_DIR/aligned.apk"
mkdir -p "$OUT_DIR"
APK="$OUT_DIR/rei-${VERSION}.apk"
FEED="$OUT_DIR/android-update.json"
rm -f "$APK" "$FEED" "$APK.idsig"
# Passwords go to apksigner through the environment (env:NAME), not through its command line.
"$BUILD_TOOLS/apksigner" sign \
  --ks "$ANDROID_KEYSTORE_PATH" --ks-key-alias "$ANDROID_KEY_ALIAS" \
  --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEY_PASSWORD \
  --v2-signing-enabled true --v3-signing-enabled true --v4-signing-enabled false \
  --out "$APK" "$WORK_DIR/aligned.apk"

say "Verifying the signature"
# At the app's minSdk (28) Android uses the v3 signature, so apksigner only reports v3 there. Verifying again as if the
# app supported Android 7 (API 24) makes it check the v2 signature block as well, which proves that both are present.
VERIFY_LOG="$WORK_DIR/verify.txt"
"$BUILD_TOOLS/apksigner" verify --verbose --print-certs --min-sdk-version "$MIN_SDK" "$APK" | tee "$VERIFY_LOG"
grep -q 'Verified using v3 scheme (APK Signature Scheme v3): true' "$VERIFY_LOG" || die "the APK is not signed with the v3 scheme."
"$BUILD_TOOLS/apksigner" verify --verbose --min-sdk-version 24 "$APK" | tee "$WORK_DIR/verify-v2.txt"
grep -q 'Verified using v2 scheme (APK Signature Scheme v2): true' "$WORK_DIR/verify-v2.txt" || die "the APK is not signed with the v2 scheme."

# --- Feed ------------------------------------------------------------------------------------------------------
say "Writing android-update.json"
# The feed is written by node so that every value is JSON-escaped and the digest comes from the final file.
FEED_PROGRAM=$(cat <<'JS'
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const env = process.env;
const feed = {
  versionCode: Number(env.FEED_VERSION_CODE),
  versionName: env.FEED_VERSION_NAME,
  apkUrl: env.FEED_APK_URL,
  sha256: createHash("sha256").update(readFileSync(env.FEED_APK_FILE)).digest("hex"),
  minSdk: Number(env.FEED_MIN_SDK),
  notes: env.FEED_NOTES,
};
process.stdout.write(`${JSON.stringify(feed, null, 2)}\n`);
JS
)
FEED_VERSION_CODE=$VERSION_CODE FEED_VERSION_NAME=$VERSION FEED_APK_URL=$APK_URL FEED_MIN_SDK=$MIN_SDK \
  FEED_NOTES="${REI_RELEASE_NOTES:-Rei for Android $VERSION.}" FEED_APK_FILE=$APK \
  node --input-type=module -e "$FEED_PROGRAM" >"$FEED"
cat "$FEED"

say "Done"
printf 'apk:  %s\nfeed: %s\n' "$APK" "$FEED"
