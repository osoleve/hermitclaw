#!/usr/bin/env bash
# Sync creature-authored BBS changes in ~/fold to git.
# Safe to run frequently — no-op if nothing changed.
set -euo pipefail

FOLD_DIR="${FOLD_DIR:-$HOME/fold}"
BBS_PATHS=".store/objects/ .store/heads/bbs/ .bbs/"

# Grab shared lock to avoid colliding with update-fold-submodule.sh
LOCKFILE="$FOLD_DIR/.git/fold-sync.lock"
exec 9>"$LOCKFILE"
if ! flock -n 9; then
    echo "Another sync/update is running, skipping." >&2
    exit 0
fi

cd "$FOLD_DIR"

# Check if any BBS paths have changes (untracked or modified)
if [ -z "$(git status --porcelain -- $BBS_PATHS 2>/dev/null)" ]; then
    exit 0
fi

# Stage only BBS paths
git add -- $BBS_PATHS

# Build commit message safely — $CHANGED can contain special chars
CHANGED=$(git diff --cached --stat -- $BBS_PATHS | tail -1)
MSG="bbs: sync creature-authored changes

$CHANGED"

# Use --file with a temp file to avoid shell quoting issues
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT
printf '%s\n' "$MSG" > "$TMPFILE"
git commit --file="$TMPFILE"

# Pull before push to avoid non-fast-forward failures
git pull --rebase --autostash
git push
