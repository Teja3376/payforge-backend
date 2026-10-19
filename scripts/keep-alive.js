/**
 * Standalone keep-alive ping script.
 * Usage:
 *   URL=https://your-service.onrender.com node scripts/keep-alive.js
 */

const targetUrl = (process.env.RENDER_EXTERNAL_URL || process.env.URL || 'https://payforge-backend.onrender.com').replace(/\/+$/, '') + '/health';
const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

console.log(`[Keep-Alive] Starting pinger for ${targetUrl} every 5 minutes...`);

async function ping() {
  try {
    const startedAt = Date.now();
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'PayForge-KeepAlive/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    console.log(`[Keep-Alive] Pinged ${targetUrl} -> status ${res.status} (${Date.now() - startedAt}ms)`);
  } catch (err) {
    console.warn(`[Keep-Alive] Ping to ${targetUrl} failed: ${err.message}`);
  }
}

// Initial ping
ping();

// Recurring ping every 5 minutes
setInterval(ping, INTERVAL_MS);
