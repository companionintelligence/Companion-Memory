#!/usr/bin/env bash
# Launch TencentDB Agent Memory's standalone TdaiGateway on the host for the
# benchmark (the tencentdb container reaches it at host.docker.internal:8420).
#
# Mirrors how the OpenViking / Hindsight servers are run out-of-band: a host
# process the user can see and kill. It only talks to local endpoints
# (LM Studio for the extractor LLM + nomic embeddings); no cloud calls.
#
# Usage:
#   tencentdb/run_gateway.sh            # clone (if needed), install, wipe DB, launch
#   tencentdb/run_gateway.sh --keep-db  # launch without wiping (resume)
#
# Env overrides:
#   TDAI_REPO   clone/checkout dir         (default /tmp/tdai-spike)
#   TDAI_DATA   gateway SQLite data dir     (default /tmp/tdai-data)
#
# IMPORTANT: the extractor model (gemma-4-31b-it-abliterated, set in
# tdai-gateway.json) must be loadable in LM Studio for L1 extraction (Phase A).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="${TDAI_REPO:-/tmp/tdai-spike}"
DATA="${TDAI_DATA:-/tmp/tdai-data}"
REMOTE="https://github.com/TencentCloud/TencentDB-Agent-Memory"

if [[ ! -d "$REPO/.git" ]]; then
  echo "==> cloning $REMOTE -> $REPO"
  git clone --depth 1 "$REMOTE" "$REPO"
fi

if [[ ! -d "$REPO/node_modules/tsx" ]]; then
  # --ignore-scripts: skip the package's postinstall, which patches a local
  # OpenClaw install. We drive the gateway directly and never touch OpenClaw.
  echo "==> npm install --ignore-scripts (in $REPO)"
  ( cd "$REPO" && npm install --ignore-scripts )
fi

mkdir -p "$DATA"
cp "$HERE/tdai-gateway.json" "$DATA/tdai-gateway.json"

if [[ "${1:-}" != "--keep-db" ]]; then
  echo "==> wiping store ($DATA/vectors.db*) for a fresh run"
  rm -f "$DATA"/vectors.db* "$DATA"/offload.jsonl 2>/dev/null || true
fi

export TDAI_GATEWAY_CONFIG="$DATA/tdai-gateway.json"
export TDAI_DATA_DIR="$DATA"
export TDAI_GATEWAY_PORT=8420
export TDAI_GATEWAY_HOST=127.0.0.1

echo "==> launching TdaiGateway on http://127.0.0.1:8420 (log: $DATA/gateway.log)"
cd "$REPO"
exec node --import tsx/esm src/gateway/server.ts
