#!/bin/sh
set -eu

: "${RUNNER_TEMP:?Run this on a temporary CI runner}"
if [ -n "${JUMP_SIGNING_DIR:-}" ]; then
    if [ "$(dirname "$JUMP_SIGNING_DIR")" != "$RUNNER_TEMP" ] || [ -L "$JUMP_SIGNING_DIR" ]; then
        echo 'Signing cleanup path is outside the job directory' >&2
        exit 1
    fi
    case "$JUMP_SIGNING_DIR" in
        "$RUNNER_TEMP"/jump-signing.*) ;;
        *) echo 'Signing cleanup path is outside the job directory' >&2; exit 1 ;;
    esac
    [ -d "$JUMP_SIGNING_DIR" ] || exit 0
    rm -f "$JUMP_SIGNING_DIR/certificate.p12"
    if [ -e "$JUMP_SIGNING_DIR/signing.keychain-db" ]; then
        security delete-keychain "$JUMP_SIGNING_DIR/signing.keychain-db" >/dev/null 2>&1
    fi
    rmdir "$JUMP_SIGNING_DIR"
fi
