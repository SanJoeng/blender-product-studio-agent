#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo 'Node.js 22 or newer is required. Install it, then run this file again.' >&2
  exit 1
fi
if [ ! -d node_modules ]; then npm ci; fi
npm run build
npm start -- --open
