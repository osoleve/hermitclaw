#!/usr/bin/env bash
# Sync creature BBS changes, then update the Fold submodule from remote.
# Intended to run via cron.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Push any creature-authored BBS changes before pulling
"$REPO_DIR/scripts/sync-bbs.sh" || true

cd "$REPO_DIR"
git submodule update --remote --merge fold
