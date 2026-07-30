#!/usr/bin/env bash

set -e

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
"${PROJECT_ROOT}/scripts/reset.sh"

printf '\nYou can close this window.\n'
