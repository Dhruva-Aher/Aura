# Deploy Aura on Render (always-on, no VPS shell)

Use this when you want the API + worker running 24/7 without managing a server. Typical cost is about **$21/month** (API + worker + Redis + Postgres starter/basic plans).

## Steps

1. Open [Render Dashboard → Blueprints](https://dashboard.render.com/blueprints).
2. Click **New Blueprint Instance**.
3. Connect GitHub and select **`Dhruva-Aher/Aura`** (branch `main`).
4. Render reads [`render.yaml`](../render.yaml) and creates:
   - `aura-api` (web)
   - `aura-worker` (background worker)
   - `aura-redis`
   - `aura-postgres`
5. Wait until **aura-api** is live. Copy its URL, e.g. `https://aura-api.onrender.com`.

## Wire Vercel console

In the Vercel project for [aurasys.vercel.app](https://aurasys.vercel.app/):

1. **Settings → Environment Variables**
2. Add **`BACKEND_URL`** = `https://aura-api.onrender.com` (no trailing slash) for **Production**
3. Redeploy production (required — build generates `vercel.json` proxy from `BACKEND_URL`)

The console uses same-origin `/api/*`; Vercel proxies to `BACKEND_URL`.

## Verify

```bash
curl -fsS https://aura-api.onrender.com/healthz
curl -fsS https://aurasys.vercel.app/api/healthz
```

Both should return `{"ok":true}`.
