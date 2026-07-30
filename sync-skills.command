#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${PROJECT_ROOT}/scripts/sync-skills.sh"

printf '\nYou can close this window.\n'
