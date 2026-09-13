# Deploy Aura on a VPS (always-on)

This replaces Railway with a single always-on VPS running API + worker + Postgres + Redis behind Caddy HTTPS.

The Operator Console stays on Vercel and talks to the VPS API over HTTPS.

## What you need

1. A VPS (Hetzner CX22 / DigitalOcean $6 droplet is enough) — Ubuntu 22.04 or 24.04
2. A domain (or subdomain) with an **A record** pointing at the VPS public IP  
   Example: `api.yourdomain.com` → `203.0.113.10`
3. Ports **80** and **443** open on the VPS firewall

> HTTPS is required. A browser on `https://aurasys.vercel.app` cannot call a plain `http://` API (mixed content).

## 1. Create the VPS

### Hetzner (recommended)
1. Create a project at [https://console.hetzner.cloud](https://console.hetzner.cloud)
2. Add a server: **Ubuntu 24.04**, location near you, **CX22** (or similar)
3. Add your SSH key
4. Note the public IPv4

### DigitalOcean
1. Create a Droplet: **Ubuntu 24.04**, Basic shared CPU ($6)
2. Add your SSH key
3. Note the public IPv4

## 2. Point DNS

Create an A record:

| Type | Name | Value |
|------|------|-------|
| A | `api` (or `@`) | your VPS IP |

Wait until `dig +short api.yourdomain.com` returns the VPS IP.

## 3. Install on the VPS

```bash
ssh root@YOUR_VPS_IP

# as a normal user is fine too — use sudo where needed
apt-get update && apt-get install -y git

git clone https://github.com/Dhruva-Aher/Aura.git
cd Aura

cp deploy/env.example .env.prod
nano .env.prod   # set DOMAIN and POSTGRES_PASSWORD
```

Set at least:

```env
DOMAIN=api.yourdomain.com
POSTGRES_PASSWORD=someLongAlphanumericPassword123
```

Avoid `@ : / ? #` in the password (breaks the composed `DATABASE_URL`).

Then:

```bash
chmod +x deploy/bootstrap-vps.sh
./deploy/bootstrap-vps.sh
```

Or manually:

```bash
curl -fsSL https://get.docker.com | sh
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Check:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
curl -fsS https://api.yourdomain.com/healthz
```

You should see `{"ok":true}`.

## 4. Point Vercel at the new API

In the Vercel project for `aurasys.vercel.app`:

1. **Settings → Environment Variables**
2. Add / update:
   - Name: `VITE_API_URL`
   - Value: `https://api.yourdomain.com` (no trailing slash)
   - Environments: Production (and Preview if you want)
3. **Deployments → Redeploy** the latest production deployment  
   (Vite bakes `VITE_*` in at build time — a redeploy is required)

After redeploy, open https://aurasys.vercel.app — metrics/workers should load from the VPS.

## 5. Day-2 ops

```bash
cd ~/Aura   # or wherever you cloned

# logs
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api worker

# restart
docker compose -f docker-compose.prod.yml --env-file .env.prod restart

# update from GitHub
git pull
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

Containers use `restart: unless-stopped`, so they come back after VPS reboots.

## Architecture

```
Browser → aurasys.vercel.app (Vercel static console)
       ↘ https://api.yourdomain.com (Caddy → api:3001)
              ├─ postgres
              ├─ redis
              └─ worker (polls redis / writes postgres)
```

## Cost ballpark

| Item | Approx. |
|------|---------|
| Hetzner CX22 / DO $6 droplet | ~$4–6 / month |
| Domain (optional if you already have one) | ~$0–12 / year |
| Vercel console | free hobby tier |

This is cheaper and more reliable for Aura than free PaaS tiers that sleep or expire.
