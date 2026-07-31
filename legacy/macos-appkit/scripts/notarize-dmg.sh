#!/bin/zsh
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <dmg-path>" >&2
  exit 1
fi

DMG_PATH="$1"
SIGN_IDENTITY="${CODEX_KEY_SWITCHER_INSTALLER_SIGN_IDENTITY:-}"
APPLE_ID="${APPLE_NOTARY_ID:-}"
TEAM_ID="${APPLE_TEAM_ID:-}"
PASSWORD="${APPLE_NOTARY_PASSWORD:-}"

if [[ ! -f "$DMG_PATH" ]]; then
  echo "Missing DMG: $DMG_PATH" >&2
  exit 1
fi

if [[ -n "$SIGN_IDENTITY" ]]; then
  codesign --force --sign "$SIGN_IDENTITY" "$DMG_PATH"
fi

if [[ -z "$APPLE_ID" || -z "$TEAM_ID" || -z "$PASSWORD" ]]; then
  echo "Set APPLE_NOTARY_ID, APPLE_TEAM_ID, and APPLE_NOTARY_PASSWORD to notarize." >&2
  exit 2
fi

xcrun notarytool submit "$DMG_PATH" \
  --apple-id "$APPLE_ID" \
  --team-id "$TEAM_ID" \
  --password "$PASSWORD" \
  --wait

xcrun stapler staple "$DMG_PATH"
spctl -a -t open --context context:primary-signature -v "$DMG_PATH"
echo "Notarized $DMG_PATH"
