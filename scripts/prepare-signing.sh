#!/bin/sh
set -eu

: "${APPLE_DEVELOPER_ID_P12_BASE64:?Set the existing Developer ID certificate archive}"
: "${APPLE_DEVELOPER_ID_P12_PASSWORD:?Set its export password}"
: "${APPLE_DEVELOPER_ID:?Set the existing Developer ID Application identity}"
: "${APPLE_ID:?Set the Apple notarization account}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?Set the notarization password}"
: "${APPLE_TEAM_ID:?Set the existing Apple team}"
: "${RUNNER_TEMP:?Run this on a temporary CI runner}"
: "${GITHUB_ENV:?Run this in a GitHub Actions job}"

[ "$APPLE_TEAM_ID" = M59NWWY4WZ ] || { echo 'Unexpected Apple team' >&2; exit 1; }
case "$APPLE_DEVELOPER_ID" in
    'Developer ID Application: '*' (M59NWWY4WZ)') ;;
    *) echo 'Unexpected signing identity' >&2; exit 1 ;;
esac

umask 077
jump_signing_dir=$(mktemp -d "$RUNNER_TEMP/jump-signing.XXXXXX")
printf 'JUMP_SIGNING_DIR=%s\n' "$jump_signing_dir" >> "$GITHUB_ENV"
jump_keychain="$jump_signing_dir/signing.keychain-db"
jump_certificate="$jump_signing_dir/certificate.p12"
jump_password=$(openssl rand -hex 24)
trap 'rm -f "$jump_certificate"' EXIT
printf '%s' "$APPLE_DEVELOPER_ID_P12_BASE64" | base64 -D > "$jump_certificate"
security create-keychain -p "$jump_password" "$jump_keychain" >/dev/null 2>&1
security set-keychain-settings -lut 21600 "$jump_keychain" >/dev/null 2>&1
security unlock-keychain -p "$jump_password" "$jump_keychain" >/dev/null 2>&1
security import "$jump_certificate" -k "$jump_keychain" -P "$APPLE_DEVELOPER_ID_P12_PASSWORD" -T /usr/bin/codesign >/dev/null 2>&1
security set-key-partition-list -S apple-tool:,apple: -s -k "$jump_password" "$jump_keychain" >/dev/null 2>&1
security list-keychains -d user -s "$jump_keychain" >/dev/null 2>&1
