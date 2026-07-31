#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$ROOT_DIR/outputs/CodexKeySwitcher.app"
SOURCES_DIR="$ROOT_DIR/work/AIKeySwitcher/Sources"
EXECUTABLE="$APP_PATH/Contents/MacOS/AIKeySwitcher"
VERSION="${1:-1.1.0}"
BUILD_NUMBER="${2:-2}"
SIGN_IDENTITY="${CODEX_KEY_SWITCHER_SIGN_IDENTITY:--}"
ARCHS="${CODEX_KEY_SWITCHER_ARCHS:-arm64 x86_64}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
ARCH_FLAGS=()

for ARCH in ${(z)ARCHS}; do
  ARCH_FLAGS+=("-arch" "$ARCH")
done

if [[ ! -d "$APP_PATH" ]]; then
  echo "Missing app bundle: $APP_PATH" >&2
  exit 1
fi

/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP_PATH/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APP_PATH/Contents/Info.plist"

clang -Wall -Wextra -fobjc-arc \
  "${ARCH_FLAGS[@]}" \
  -mmacosx-version-min="$MACOSX_DEPLOYMENT_TARGET" \
  -framework Cocoa \
  -framework Security \
  -framework ServiceManagement \
  "$SOURCES_DIR"/*.m \
  -o "$EXECUTABLE"

if [[ "$SIGN_IDENTITY" == "-" ]]; then
  codesign --force --deep --options runtime --sign - "$APP_PATH"
else
  codesign --force --deep --timestamp --options runtime --sign "$SIGN_IDENTITY" "$APP_PATH"
fi
codesign --verify --deep --strict "$APP_PATH"

echo "Built $APP_PATH"
echo "Version $VERSION ($BUILD_NUMBER)"
lipo -info "$EXECUTABLE"
