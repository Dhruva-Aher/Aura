# Free cloud stack (student) — no local server required

Aura on **$0/month** cloud services. Tradeoff: the API **sleeps after ~15 minutes** of no traffic; the first hit can take 30–60 seconds to wake.

## Architecture

| Piece | Free provider |
|-------|----------------|
| Operator Console | Vercel (already at aurasys.vercel.app) |
| API + workers (same process) | Render **Free** web service |
| Postgres | [Neon](https://neon.tech) free |
| Redis | [Upstash](https://upstash.com) free |

Workers run **inside** the API (`EMBEDDED_WORKER=true`) so you do not need a paid Render Background Worker.

## 1. Neon (Postgres)

1. Sign up at https://console.neon.tech (GitHub login is fine).
2. Create a project (e.g. `aura`).
3. Copy the connection string (**DATABASE_URL**).  
   It should look like:  
   `postgresql://user:pass@ep-xxxx.neon.tech/neondb?sslmode=require`

## 2. Upstash (Redis)

1. Sign up at https://console.upstash.com.
2. Create a Redis database (region near you).
3. Copy the **Redis URL** (`rediss://...`) as **REDIS_URL**.

## 3. Render (API)

1. Open https://dashboard.render.com/blueprints → **New Blueprint Instance**.
2. Connect GitHub → select **Dhruva-Aher/Aura** → branch `main`.
3. Confirm the service uses plan **Free** (not Starter).
4. When prompted for env vars, paste:
   - `DATABASE_URL` = Neon URL  
   - `REDIS_URL` = Upstash URL  
5. Deploy. Wait until **aura-api** is Live.
6. Copy the service URL, e.g. `https://aura-api.onrender.com`.

Verify:

```bash
curl -fsS https://aura-api.onrender.com/healthz
```

## 4. Vercel (console → API)

In the Vercel project for **aurasys.vercel.app**:

1. **Settings → Environment Variables**
2. Add **`BACKEND_URL`** = `https://aura-api.onrender.com` (no trailing slash) → Production
3. **Redeploy** the latest production deployment

Optional: also set `VITE_API_URL` to the same URL if you prefer a direct client call instead of the `/api` proxy.

Verify:

```bash
curl -fsS https://aurasys.vercel.app/api/healthz
```

## Light load (already set in render.yaml)

- 1 worker, concurrency 5  
- Job generator off  
- Lower enqueue rate / queue cap  

Do **not** turn on `JOB_GENERATOR_ENABLED` on free tier.

## Limits to expect

- Sleep after idle → slow first request  
- Neon / Upstash free quotas  
- Not for heavy load tests  

If Render still asks for a card on Free, use their free signup flow or create a **Web Service** manually (Free plan) with the same build/start commands and env vars from this file — some accounts require card verification even for free.
