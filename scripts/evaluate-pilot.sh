#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_PATH="$("${PROJECT_ROOT}/scripts/node-runtime.sh" --install)"
PATH="$(dirname "${NODE_PATH}"):${PATH}"
export PATH

exec "${NODE_PATH}" "${PROJECT_ROOT}/scripts/evaluate-pilot.mjs" "$@"
