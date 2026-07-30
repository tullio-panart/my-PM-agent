#!/usr/bin/env bash

set +e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"${PROJECT_ROOT}/scripts/diagnose.sh"
STATUS=$?

printf '\nYou can close this window.\n'
exit "${STATUS}"
