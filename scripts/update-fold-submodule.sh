#!/usr/bin/env bash
# Sync creature BBS changes, then update the Fold submodule from remote.
# Intended to run via cron. Uses flock to prevent concurrent git operations.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FOLD_DIR="${FOLD_DIR:-$HOME/fold}"
LOCKFILE="$FOLD_DIR/.git/fold-sync.lock"

# Ensure only one instance runs at a time across sync-bbs and submodule update.
# -n = non-blocking: if another instance holds the lock, exit immediately.
# -E 0 = exit 0 on lock failure (no-op is fine for cron).
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    echo "Another sync/update is running, skipping." >&2
    exit 0
fi

# Clean up stale git index.lock if it exists and is older than 10 minutes
INDEX_LOCK="$FOLD_DIR/.git/index.lock"
if [ -f "$INDEX_LOCK" ]; then
    if find "$INDEX_LOCK" -mmin +10 -print -quit | grep -q .; then
        echo "Removing stale index.lock (older than 10 min)" >&2
        rm -f "$INDEX_LOCK"
    fi
fi

# Push any creature-authored BBS changes before pulling
"$REPO_DIR/scripts/sync-bbs.sh" || true

cd "$REPO_DIR"
git submodule update --remote --merge fold
