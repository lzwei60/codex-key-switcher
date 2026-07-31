#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH="$ROOT_DIR/outputs/CodexKeySwitcher.app"
SOURCES_DIR="$ROOT_DIR/work/AIKeySwitcher/Sources"
EXECUTABLE="$APP_PATH/Contents/MacOS/AIKeySwitcher"
ARCHS="${CODEX_KEY_SWITCHER_ARCHS:-arm64 x86_64}"
MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-13.0}"
ARCH_FLAGS=()

"$ROOT_DIR/scripts/build-release.sh" "${1:-1.1.0}" "${2:-local}"

for ARCH in ${(z)ARCHS}; do
  ARCH_FLAGS+=("-arch" "$ARCH")
done

clang --analyze -fobjc-arc \
  "${ARCH_FLAGS[@]}" \
  -mmacosx-version-min="$MACOSX_DEPLOYMENT_TARGET" \
  -framework Cocoa \
  -framework Security \
  -framework ServiceManagement \
  "$SOURCES_DIR"/*.m

plutil -lint "$APP_PATH/Contents/Info.plist"
codesign --verify --deep --strict "$APP_PATH"

BINARY_ARCHS="$(lipo -archs "$EXECUTABLE")"
if ! echo " $BINARY_ARCHS " | grep -q ' arm64 '; then
  echo "Missing arm64 slice in $EXECUTABLE" >&2
  exit 5
fi
if ! echo " $BINARY_ARCHS " | grep -q ' x86_64 '; then
  echo "Missing x86_64 slice in $EXECUTABLE" >&2
  exit 6
fi

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$APP_PATH/Contents/Info.plist")"
if ! echo "$BUNDLE_ID" | grep -Eq '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$'; then
  echo "Bundle identifier is not a stable reverse-DNS value." >&2
  exit 3
fi
if [[ "$BUNDLE_ID" == local.* ]]; then
  echo "Warning: Bundle identifier is still local.*. Replace it before public distribution." >&2
fi

if grep -R 'Access-Control-Allow-Origin": @"\\*"' "$SOURCES_DIR" >/dev/null; then
  echo "Wildcard CORS is still present. Review before public distribution." >&2
  exit 4
fi

echo "Release checks passed."
