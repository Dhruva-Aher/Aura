#!/usr/bin/env bash
# Starts Docker backend + Cloudflare quick tunnel. Keeps running while this Mac is on.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RUN_DIR="$ROOT/.run"
mkdir -p "$RUN_DIR"

CF="${CLOUDFLARED_BIN:-cloudflared}"
if ! command -v "$CF" >/dev/null 2>&1; then
  if [[ -x /tmp/cloudflared ]]; then CF=/tmp/cloudflared; else
    echo "Install cloudflared: brew install cloudflared" >&2
    exit 1
  fi
fi

"$ROOT/deploy/run-local-backend.sh" "${1:-.env.local}"

if [[ -f "$RUN_DIR/cloudflared.pid" ]] && kill -0 "$(cat "$RUN_DIR/cloudflared.pid")" 2>/dev/null; then
  echo "cloudflared already running (pid $(cat "$RUN_DIR/cloudflared.pid"))"
else
  nohup "$CF" tunnel --url http://127.0.0.1:3001 >"$RUN_DIR/cloudflared.log" 2>&1 &
  echo $! >"$RUN_DIR/cloudflared.pid"
  echo "Started cloudflared (pid $(cat "$RUN_DIR/cloudflared.pid"))"
fi

for _ in $(seq 1 30); do
  URL="$(rg -o 'https://[a-z0-9-]+\.trycloudflare\.com' "$RUN_DIR/cloudflared.log" | tail -1 || true)"
  if [[ -n "$URL" ]]; then
    echo "Public API URL: $URL"
    echo "Set Vercel BACKEND_URL=$URL (Production) and redeploy, or use Render (see docs/DEPLOY_RENDER.md)."
    exit 0
  fi
  sleep 2
done

echo "Tunnel URL not found yet. See $RUN_DIR/cloudflared.log" >&2
exit 1
