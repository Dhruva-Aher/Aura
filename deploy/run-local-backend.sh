#!/usr/bin/env bash
# Start Aura API + worker + Postgres + Redis on this machine (Docker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${1:-.env.local}"
if [[ ! -f "$ENV_FILE" ]]; then
  cp deploy/env.example "$ENV_FILE"
  # Local compose does not need DOMAIN; strip or ignore.
  if ! grep -q '^POSTGRES_PASSWORD=' "$ENV_FILE" || grep -q 'change-me' "$ENV_FILE"; then
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" >> "$ENV_FILE"
  fi
fi

echo "Starting local backend stack..."
docker compose -f docker-compose.local.yml --env-file "$ENV_FILE" up -d --build

echo "Waiting for API health..."
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:3001/healthz >/dev/null 2>&1; then
    echo "API is up at http://127.0.0.1:3001"
    exit 0
  fi
  sleep 3
done

echo "API did not become healthy in time. Logs:" >&2
docker compose -f docker-compose.local.yml --env-file "$ENV_FILE" logs api --tail 80 >&2
exit 1
