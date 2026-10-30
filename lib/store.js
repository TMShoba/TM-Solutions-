// Storage for projects + settings, and rate-limit counters.
//  • On Vercel: Upstash Redis over its REST API (env vars are added by Vercel's Upstash integration).
//  • Locally / on a normal server: JSON files in DATA_DIR.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
// Vercel's Upstash integration may add a custom prefix to the variable names (e.g. STORAGE_KV_REST_API_URL),
// so accept any variable that ends with the standard name.
const envEnding = (...endings) => {
  const key = Object.keys(process.env).find((k) => process.env[k] && endings.some((e) => k === e || k.endsWith('_' + e)) && !/READ_ONLY/.test(k));
  return key ? process.env[key] : '';
};
const REST_URL = envEnding('KV_REST_API_URL', 'UPSTASH_REDIS_REST_URL');
const REST_TOKEN = envEnding('KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_TOKEN');
const remote = Boolean(REST_URL && REST_TOKEN);
const NO_DB = 'No database is connected. In Vercel open your project → Storage, add Upstash Redis, connect it to this project, then redeploy.';

async function redis(...cmd) {
  const r = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error('Database error: ' + (j.error || r.status));
  return j.result;
}

const file = (key) => path.join(DATA_DIR, key + '.json');

async function get(key, fallback) {
  if (remote) {
    const v = await redis('GET', 'tm:' + key);
    return v == null ? fallback : JSON.parse(v);
  }
  try { return JSON.parse(fs.readFileSync(file(key), 'utf8')); } catch { return fallback; }
}

async function set(key, value) {
  if (remote) return redis('SET', 'tm:' + key, JSON.stringify(value));
  if (process.env.VERCEL) throw new Error(NO_DB); // Vercel's disk is read-only, so files can't be used there
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file(key) + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file(key) + '.tmp', file(key));
}

// ---- rate limiting: shared across serverless instances when Redis is available ----
const mem = new Map(); // key -> { n, exp }
const rate = {
  async peek(key) {
    if (remote) return Number(await redis('GET', 'tm:rl:' + key)) || 0;
    const e = mem.get(key);
    return e && e.exp > Date.now() ? e.n : 0;
  },
  async hit(key, ttlSec) {
    if (remote) {
      const n = Number(await redis('INCR', 'tm:rl:' + key));
      if (n === 1) await redis('EXPIRE', 'tm:rl:' + key, ttlSec);
      return n;
    }
    const e = mem.get(key);
    if (e && e.exp > Date.now()) return ++e.n;
    mem.set(key, { n: 1, exp: Date.now() + ttlSec * 1000 });
    return 1;
  },
};

module.exports = { get, set, rate, remote, DATA_DIR };
