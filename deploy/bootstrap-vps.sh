#!/usr/bin/env bash
# Run on a fresh Ubuntu 22.04/24.04 VPS after cloning the repo.
set -euo pipefail

if [[ ! -f docker-compose.prod.yml ]]; then
  echo "Run this from the Aura repo root." >&2
  exit 1
fi

if [[ ! -f .env.prod ]]; then
  echo "Missing .env.prod — copy deploy/env.example and edit DOMAIN + POSTGRES_PASSWORD." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker..."
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
fi

echo "Building and starting Aura (api + worker + postgres + redis + caddy)..."
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build

echo
echo "Status:"
docker compose -f docker-compose.prod.yml --env-file .env.prod ps

DOMAIN="$(grep -E '^DOMAIN=' .env.prod | cut -d= -f2-)"
echo
echo "API should be at: https://${DOMAIN}/healthz"
echo "Then set Vercel env VITE_API_URL=https://${DOMAIN} and redeploy the console."
