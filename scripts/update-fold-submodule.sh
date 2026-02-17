#!/usr/bin/env bash
# Update the Fold submodule from remote.
# Intended to run via cron.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_DIR"
git submodule update --remote --merge fold
