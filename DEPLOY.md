# Deploying the CS2 Portfolio Proxy Worker

A 5-minute walkthrough to get a free Cloudflare Worker proxying Skinport prices and Steam inventory for your dashboard.

## What this does

The Worker runs on Cloudflare's edge network and acts as a relay between your dashboard and the upstream APIs. It:

- Fetches Skinport prices server-side (where Brotli encoding and bot challenges aren't blockers)
- Fetches Steam inventory server-side (where CORS doesn't apply)
- Caches both at the edge so a thousand users share one upstream call
- Returns clean JSON to your dashboard with proper CORS headers

You won't pay anything for this. Cloudflare's free Workers tier covers 100,000 requests per day. A single dashboard hit costs ~3 requests, so you'd need 30,000+ daily users to brush the limit.

## What you need

1. A Cloudflare account ([cloudflare.com/signup](https://dash.cloudflare.com/sign-up) — free, no card)
2. Node.js 18+ on your machine ([nodejs.org](https://nodejs.org))
3. A terminal you're comfortable in

That's it. No domain required — Cloudflare gives you a free `*.workers.dev` subdomain.

## Step 1 — Install Wrangler

Wrangler is Cloudflare's deploy tool.

```bash
npm install -g wrangler
```

Verify:

```bash
wrangler --version
```

## Step 2 — Log in

```bash
wrangler login
```

This opens your browser, you click "Allow", that's it. Wrangler stashes a token locally.

## Step 3 — Pull down the worker files

You should have these two files from this kit:

- `worker.js` — the Worker code
- `wrangler.toml` — the Worker config

Put them in any folder, then `cd` into it:

```bash
mkdir cs2-portfolio-proxy
cd cs2-portfolio-proxy
# (drop worker.js and wrangler.toml in here)
```

## Step 4 — Deploy

```bash
wrangler deploy
```

That's literally it. Output looks like:

```
Total Upload: 5.42 KiB / gzip: 2.18 KiB
Uploaded cs2-portfolio-proxy (1.23 sec)
Published cs2-portfolio-proxy (3.45 sec)
  https://cs2-portfolio-proxy.<your-cf-subdomain>.workers.dev
Current Deployment ID: ...
```

**Copy the `https://cs2-portfolio-proxy.<...>.workers.dev` URL.** That's your Worker URL. You'll paste it into the dashboard once.

## Step 5 — Test the deploy

```bash
curl https://cs2-portfolio-proxy.<your-subdomain>.workers.dev/health
```

You should get back:

```json
{"ok":true,"time":"2026-...","version":"1.0.0"}
```

Then test prices (this fetch takes a few seconds the first time as it hits Skinport upstream, then sub-100ms on subsequent calls thanks to edge cache):

```bash
curl https://cs2-portfolio-proxy.<your-subdomain>.workers.dev/prices | head -c 200
```

You should see the start of a JSON response with thousands of items.

## Step 6 — Wire it into the dashboard

Open `cs2_portfolio.html` in a browser. In the Setup section, you'll see a new **Proxy URL** field next to Live Pricing. Paste your Worker URL there and hit save. Click **Refresh prices** — should now succeed.

## Optional — Lock down CORS

By default the Worker accepts requests from any origin. Fine for personal use. If you want to host the dashboard at a fixed URL and lock down the Worker to only that origin:

Edit `wrangler.toml`, uncomment the `ALLOWED_ORIGINS` line, set it to your dashboard URL:

```toml
[vars]
ALLOWED_ORIGINS = "https://my-cs2-dashboard.example.com"
```

Re-deploy:

```bash
wrangler deploy
```

You can list multiple origins comma-separated.

## Troubleshooting

**`wrangler deploy` fails with "you need to login"**
→ Run `wrangler login` again. Token may have expired.

**Curl to `/health` works but `/prices` returns 502**
→ Skinport's upstream is rate-limiting or under bot protection that even server-side hit. Wait ~10 minutes and retry. The Worker exists specifically to absorb intermittent upstream failures, but it can't conjure data Skinport refuses to serve.

**Curl returns the JSON correctly, but the dashboard says "blocked"**
→ The dashboard's saved Worker URL might have a typo. Open the dashboard, go to Setup → Live Pricing, verify the Proxy URL field matches your `workers.dev` URL exactly (no trailing slash).

**Browser console: "CORS error"**
→ Means the `ALLOWED_ORIGINS` env var is set in `wrangler.toml` and your dashboard origin doesn't match it. Either remove the var (for "any origin"), or add your origin to it, then `wrangler deploy` again.

## Updating the Worker later

Edit `worker.js`, then:

```bash
wrangler deploy
```

That's the whole update flow. New version goes live in seconds.

## Tearing it down

If you want to remove the Worker entirely:

```bash
wrangler delete
```

This wipes it from Cloudflare. No cleanup needed elsewhere.

## What this costs

- Cloudflare Workers free tier: 100,000 requests/day, 10ms CPU per request. Plenty for personal/friend-group use.
- Skinport upstream: one fetch per 12 hours regardless of dashboard traffic, since the edge cache absorbs the rest.
- Steam upstream: limited by Steam's own rate limits per IP, not by Cloudflare.

For a friend group of 10–20 daily users, this stays at $0/month indefinitely.
