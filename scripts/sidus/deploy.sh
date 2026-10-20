#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="wrangler.sidus.jsonc"
cd "$repository_root"

refuse() {
  echo "deploy.sh: $1" >&2
  exit 1
}

if [[ -n "${OOMOL_CONNECT_RUNTIME_TOKEN:-}" ]]; then
  refuse "unset OOMOL_CONNECT_RUNTIME_TOKEN before you deploy"
fi
if [[ -n "$(git status --porcelain)" ]]; then
  refuse "the working tree is dirty"
fi
if grep -q '"database_id": "SET_AT_FIRST_DEPLOY"' "$config"; then
  refuse "set the D1 database_id in $config first"
fi

npm ci
npm run generate:catalog
npm run build:web
node scripts/copy-catalog-assets.ts
npx wrangler d1 migrations apply open-connector --remote --config "$config"
npx wrangler deploy --config "$config" --minify
node scripts/sidus/runtime-tokens.mjs
