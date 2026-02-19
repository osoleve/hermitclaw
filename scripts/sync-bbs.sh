#!/usr/bin/env bash
# Sync creature-authored BBS changes in ~/fold to git.
# Safe to run frequently — no-op if nothing changed.
set -euo pipefail

FOLD_DIR="${FOLD_DIR:-$HOME/fold}"
BBS_PATHS=".store/objects/ .store/heads/bbs/ .bbs/"

cd "$FOLD_DIR"

# Check if any BBS paths have changes (untracked or modified)
if [ -z "$(git status --porcelain -- $BBS_PATHS 2>/dev/null)" ]; then
    exit 0
fi

# Stage only BBS paths
git add -- $BBS_PATHS

# Commit only what we just staged
CHANGED=$(git diff --cached --stat -- $BBS_PATHS | tail -1)
git commit -m "bbs: sync creature-authored changes

$CHANGED" -- $BBS_PATHS

# Pull before push to avoid non-fast-forward failures
git pull --rebase --autostash
git push
