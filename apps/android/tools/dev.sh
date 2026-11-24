#!/usr/bin/env bash
# Quick loop for the Rei Android client on this machine: start the emulator if needed, forward the server port,
# build and install the debug APK, and launch it.
#
#   tools/dev.sh                 phone emulator (Rei_Phone), build, install, launch
#   tools/dev.sh tablet          use Rei_Tablet instead
#   tools/dev.sh --test          also run the unit tests before installing
#   tools/dev.sh --no-build      reuse the installed build: just start the emulator, forward the port and launch
#   tools/dev.sh --wipe          cold boot with wiped data (signs you out)
#
# Debug builds only: the sideload release has a different signing key and cannot be installed over a debug build.
set -euo pipefail

# Android SDK: ANDROID_HOME, then ANDROID_SDK_ROOT, then the standard install path of the platform.
# ANDROID_AVD_HOME and GRADLE_USER_HOME are only passed through when you set them.
case "$(uname -s)" in
  Darwin)
    default_sdk="$HOME/Library/Android/sdk"
    default_jdk="/Applications/Android Studio.app/Contents/jbr/Contents/Home" ;;
  *)
    default_sdk="$HOME/Android/Sdk"
    default_jdk="" ;;
esac
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$default_sdk}}"
if [ -z "${JAVA_HOME:-}" ] && [ -n "$default_jdk" ] && [ -d "$default_jdk" ]; then export JAVA_HOME="$default_jdk"; fi
if [ ! -d "$ANDROID_HOME" ]; then
  echo "Android SDK not found at $ANDROID_HOME. Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your SDK folder." >&2
  exit 1
fi
export PATH="${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

AVD=Rei_Phone
RUN_TESTS=0
BUILD=1
WIPE=()
PORT="${REI_PORT:-8787}"
APP_ID=dev.rei.android

for arg in "$@"; do
  case "$arg" in
    tablet) AVD=Rei_Tablet ;;
    phone) AVD=Rei_Phone ;;
    --test) RUN_TESTS=1 ;;
    --no-build) BUILD=0 ;;
    --wipe) WIPE=(-wipe-data -no-snapshot-load) ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# 1. Emulator: reuse a running one, otherwise start $AVD in the background and wait for it to finish booting.
if adb devices | awk 'NR>1 && $2=="device"' | grep -q .; then
  say "Using the emulator that is already running"
else
  say "Starting $AVD"
  mkdir -p .local
  nohup emulator -avd "$AVD" -netdelay none -netspeed full ${WIPE[@]+"${WIPE[@]}"} >".local/emulator.log" 2>&1 &
  adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
fi

# 2. Reach the Rei server running on this machine at http://127.0.0.1:$PORT from inside the emulator.
say "Forwarding port $PORT"
adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
if ! curl -s -o /dev/null --max-time 3 "http://127.0.0.1:$PORT/api/health"; then
  echo "Note: nothing answers at http://127.0.0.1:$PORT yet; start the Rei server before you sign in."
fi

# 3. Build and install.
if [ "$BUILD" = 1 ]; then
  if [ "$RUN_TESTS" = 1 ]; then
    say "Unit tests"
    ./gradlew --offline testDebugUnitTest --console=plain -q
  fi
  say "Building and installing the debug app"
  ./gradlew --offline installDebug --console=plain -q
fi

# 4. Launch.
say "Launching Rei"
adb shell monkey -p "$APP_ID" -c android.intent.category.LAUNCHER 1 >/dev/null
echo "Connect to http://127.0.0.1:$PORT and sign in. Log: adb logcat --pid=\$(adb shell pidof $APP_ID)"
