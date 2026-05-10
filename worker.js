/**
 * cs2-portfolio-proxy — Cloudflare Worker (v2.0)
 *
 * Proxies the Steam public inventory endpoint to bypass the missing CORS headers
 * that block browser-direct fetches of inventory data.
 *
 * Routes:
 *   GET  /health                   → readiness check
 *   GET  /inventory/:steamid64     → Steam public inventory JSON, cached 60s
 *
 * History note (v1.x had /prices for Skinport):
 *   The /prices route was removed in v2.0 because Skinport's API now blocks
 *   Cloudflare Worker requests at the TLS-fingerprint level. No header tweaking
 *   gets through. There's no free CS2 bulk-price API in 2026, so live pricing
 *   was dropped from the dashboard entirely. Manual price entry replaces it.
 *
 * Caching:
 *   Inventory cached 60s per SteamID. Stops accidental spam-clicking from
 *   rate-limiting the user with Steam.
 *
 * CORS:
 *   By default allows any origin. To lock down to your own dashboard URL,
 *   set the ALLOWED_ORIGINS env var (comma-separated).
 *
 * Deployed via wrangler. See DEPLOY.md.
 */

const INVENTORY_TTL_SECONDS = 60;   // 1 minute
const PRICE_TTL_SECONDS     = 3600; // 1 hour — Steam market prices don't need sub-minute freshness

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // --- CORS preflight ---
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, env),
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin, env);
    }

    // --- Token auth (optional) ---
    // If WORKER_TOKEN secret is set, every route except /health requires the header.
    // Set via: wrangler secret put WORKER_TOKEN   (never put the value in wrangler.toml)
    if (env.WORKER_TOKEN && url.pathname !== '/health') {
      const provided = request.headers.get('X-Worker-Token');
      if (provided !== env.WORKER_TOKEN) {
        return jsonResponse({
          error: 'Unauthorized',
          hint: 'Set X-Worker-Token header to match the WORKER_TOKEN secret on this worker.',
        }, 401, origin, env);
      }
    }

    try {
      // --- Routes ---
      if (url.pathname === '/health') {
        return jsonResponse({
          ok: true,
          time: new Date().toISOString(),
          version: '2.1.0',
          features: ['inventory', 'price'],
        }, 200, origin, env);
      }

      if (url.pathname.startsWith('/inventory/')) {
        const steamId = url.pathname.slice('/inventory/'.length);
        return await handleInventory(steamId, env, ctx, origin);
      }

      if (url.pathname === '/price') {
        const name = url.searchParams.get('name');
        return await handlePrice(name, env, ctx, origin);
      }

      // /prices intentionally removed in v2.0 — see header note
      if (url.pathname === '/prices') {
        return jsonResponse({
          error: 'Endpoint removed in v2.0',
          hint: 'Use /price?name=... for individual Steam Market prices.',
        }, 410, origin, env);
      }

      return jsonResponse({ error: 'Not found', path: url.pathname }, 404, origin, env);
    } catch (err) {
      return jsonResponse({
        error: 'Worker exception',
        message: err.message,
        stack: env.DEBUG === 'true' ? err.stack : undefined,
      }, 500, origin, env);
    }
  },
};

// =====================================================================
// /inventory/:steamid64 — Steam public inventory pass-through
// Steam doesn't send CORS headers either, so we proxy the same way.
// =====================================================================
async function handleInventory(steamId, env, ctx, origin) {
  if (!/^\d{17}$/.test(steamId)) {
    return jsonResponse({ error: 'Invalid SteamID64 (must be 17 digits)' }, 400, origin, env);
  }

  const cacheKey = new Request(`https://cache.local/inventory/${steamId}?v=1`);
  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (cached) {
    const r = new Response(cached.body, cached);
    applyCors(r.headers, origin, env);
    r.headers.set('X-Cache', 'HIT');
    return r;
  }

  const upstreamUrl = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=2000`;
  const upstream = await fetch(upstreamUrl, {
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      // Realistic browser UA — Steam fingerprints aggressively from Workers IPs
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    },
    cf: {
      cacheTtl: INVENTORY_TTL_SECONDS,
      cacheEverything: true,
    },
  });

  if (upstream.status === 403) {
    return jsonResponse({
      error: 'Inventory is private',
      hint: 'In Steam → Privacy Settings, set Profile and Inventory to Public.',
    }, 403, origin, env);
  }
  if (upstream.status === 429) {
    return jsonResponse({
      error: 'Rate limited by Steam',
      hint: 'Try again in a few minutes. Steam limits inventory fetches per IP.',
    }, 429, origin, env);
  }
  if (!upstream.ok) {
    return jsonResponse({
      error: 'Upstream error',
      source: 'steam',
      status: upstream.status,
    }, 502, origin, env);
  }

  const json = await upstream.json();
  const body = JSON.stringify(json);
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${INVENTORY_TTL_SECONDS}`,
      'X-Cache': 'MISS',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  applyCors(response.headers, origin, env);
  return response;
}

// =====================================================================
// /price?name=... — Steam Market price for a single CS2 item
// Cached 1 hour. Returns { market_hash_name, lowest_price, median_price, volume }
// =====================================================================
async function handlePrice(name, env, ctx, origin) {
  if (!name || !name.trim()) {
    return jsonResponse({ error: 'Missing required query param: name' }, 400, origin, env);
  }

  const cacheKey = new Request(`https://cache.local/price/${encodeURIComponent(name)}?v=1`);
  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (cached) {
    const r = new Response(cached.body, cached);
    applyCors(r.headers, origin, env);
    r.headers.set('X-Cache', 'HIT');
    return r;
  }

  const upstreamUrl = `https://steamcommunity.com/market/priceoverview/?appid=730&currency=1&market_hash_name=${encodeURIComponent(name)}`;
  const upstream = await fetch(upstreamUrl, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    },
    cf: { cacheTtl: PRICE_TTL_SECONDS, cacheEverything: true },
  });

  if (upstream.status === 429) {
    return jsonResponse({ error: 'Rate limited by Steam', hint: 'Wait a few minutes and try again.' }, 429, origin, env);
  }
  if (!upstream.ok) {
    return jsonResponse({ error: 'Upstream error', source: 'steam-market', status: upstream.status }, 502, origin, env);
  }

  const data = await upstream.json();
  if (!data.success) {
    return jsonResponse({ error: 'Item not found on Steam Market', market_hash_name: name }, 404, origin, env);
  }

  const parseDollars = str => str ? parseFloat(str.replace(/[^0-9.]/g, '')) : null;
  const result = {
    market_hash_name: name,
    lowest_price:  parseDollars(data.lowest_price),
    median_price:  parseDollars(data.median_price),
    volume:        parseInt(data.volume?.replace(/,/g, '') || '0', 10),
  };

  const body = JSON.stringify(result);
  const response = new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${PRICE_TTL_SECONDS}`,
      'X-Cache': 'MISS',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  applyCors(response.headers, origin, env);
  return response;
}

// =====================================================================
// Helpers
// =====================================================================
function corsHeaders(origin, env) {
  const headers = new Headers();
  applyCors(headers, origin, env);
  return headers;
}

function applyCors(headers, origin, env) {
  // env.ALLOWED_ORIGINS = comma-separated list, or unset = allow all
  const allowList = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  let allowedOrigin = '*';
  if (allowList.length) {
    allowedOrigin = allowList.includes(origin) ? origin : allowList[0];
  }
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Worker-Token');
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Vary', 'Origin');
}

function jsonResponse(obj, status, origin, env) {
  const body = JSON.stringify(obj);
  const response = new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
  applyCors(response.headers, origin, env);
  return response;
}
