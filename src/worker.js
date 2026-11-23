// DrivEnglish API — Cloudflare Worker + D1.
// Statické soubory (public/) servíruje assets binding; Worker obsluhuje jen /api/*.
import { DEFAULT_CATEGORY, DEFAULT_WORDS } from './seed.js';

const LIMITS = { name: 60, en: 200, cs: 200, description: 1000, bulk: 1000 };
const DAY_MS = 86_400_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await handleApi(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: 'Internal error' }, 500);
    }
  },
};

/* ───────── routing ───────── */

async function handleApi(request, env, url) {
  const email = await authenticate(request, env, url);
  const user = await ensureUser(env, email);
  const access = accessStatus(user, env);
  const method = request.method;
  const path = url.pathname.replace(/\/+$/, '');

  if (path === '/api/me' && method === 'GET') return json(access);
  if (access.status === 'expired') return json({ error: 'Trial expired', ...access }, 402);

  let m;
  if (path === '/api/categories') {
    if (method === 'GET') return json(await listCategories(env, email));
    if (method === 'POST') return json(await createCategory(env, email, await body(request)), 201);
  }
  if ((m = path.match(/^\/api\/categories\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') return json(await renameCategory(env, email, id, await body(request)));
    if (method === 'DELETE') return json(await deleteCategory(env, email, id));
  }
  if (path === '/api/words') {
    if (method === 'GET') return json(await listWords(env, email, url.searchParams.get('category')));
    if (method === 'POST') return json(await createWord(env, email, await body(request)), 201);
  }
  if (path === '/api/words/bulk' && method === 'POST') {
    return json(await bulkWords(env, email, await body(request)), 201);
  }
  if ((m = path.match(/^\/api\/words\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === 'PATCH') return json(await updateWord(env, email, id, await body(request)));
    if (method === 'DELETE') return json(await deleteWord(env, email, id));
  }
  throw new HttpError(404, 'Not found');
}

/* ───────── auth (Cloudflare Access JWT) ───────── */

async function authenticate(request, env, url) {
  // Lokální vývoj: DEV_USER_EMAIL jen z .dev.vars a jen na localhostu.
  if (env.DEV_USER_EMAIL && ['localhost', '127.0.0.1'].includes(url.hostname)) {
    return normEmail(env.DEV_USER_EMAIL);
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) throw new HttpError(401, 'Missing Access token');
  const payload = await verifyAccessJwt(token, env);
  if (!payload.email) throw new HttpError(401, 'Token has no email');
  return normEmail(payload.email);
}

let jwksCache = { keys: null, at: 0 };

async function getJwks(env) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 3_600_000) return jwksCache.keys;
  const res = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HttpError(503, 'Cannot fetch Access certs');
  const { keys } = await res.json();
  jwksCache = { keys, at: Date.now() };
  return keys;
}

async function verifyAccessJwt(token, env) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed token');
  let header, payload;
  try {
    header = JSON.parse(b64urlDecodeText(parts[0]));
    payload = JSON.parse(b64urlDecodeText(parts[1]));
  } catch {
    throw new HttpError(401, 'Malformed token');
  }
  if (header.alg !== 'RS256') throw new HttpError(401, 'Unsupported alg');

  let jwk = (await getJwks(env)).find(k => k.kid === header.kid);
  if (!jwk) { jwksCache.at = 0; jwk = (await getJwks(env)).find(k => k.kid === header.kid); }
  if (!jwk) throw new HttpError(401, 'Unknown key');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, b64urlDecode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new HttpError(401, 'Bad signature');

  const now = Math.floor(Date.now() / 1000);
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) throw new HttpError(401, 'Bad audience');
  if (payload.exp && payload.exp < now) throw new HttpError(401, 'Token expired');
  if (payload.iss && payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) throw new HttpError(401, 'Bad issuer');
  return payload;
}

function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
function b64urlDecodeText(s) { return new TextDecoder().decode(b64urlDecode(s)); }
function normEmail(e) { return String(e).trim().toLowerCase(); }

/* ───────── trial / paywall ───────── */

async function ensureUser(env, email) {
  await env.DB.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)').bind(email).run();
  return env.DB.prepare('SELECT email, first_seen, paid_until FROM users WHERE email = ?').bind(email).first();
}

function accessStatus(user, env) {
  const trialDays = Number(env.TRIAL_DAYS) || 30;
  const trialEnds = new Date(parseDate(user.first_seen) + trialDays * DAY_MS);
  const paidUntil = user.paid_until ? new Date(parseDate(user.paid_until)) : null;
  const now = Date.now();
  let status = 'expired';
  if (paidUntil && paidUntil.getTime() > now) status = 'paid';
  else if (trialEnds.getTime() > now) status = 'trial';
  return {
    email: user.email,
    status,
    trial_days: trialDays,
    trial_ends_at: trialEnds.toISOString(),
    paid_until: paidUntil ? paidUntil.toISOString() : null,
  };
}

// SQLite CURRENT_TIMESTAMP = "YYYY-MM-DD HH:MM:SS" (UTC, bez zóny); ruční zápis může být jen "YYYY-MM-DD".
function parseDate(s) {
  let v = String(s).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) v += 'T23:59:59Z';
  else if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(v)) v += 'Z';
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/* ───────── categories ───────── */

async function listCategories(env, email) {
  const sql = `SELECT c.id, c.name, COUNT(w.id) AS word_count
               FROM categories c LEFT JOIN words w ON w.category_id = c.id
               WHERE c.user_email = ? GROUP BY c.id ORDER BY c.name COLLATE NOCASE`;
  let { results } = await env.DB.prepare(sql).bind(email).all();
  if (!results.length) {
    await seedUser(env, email);
    ({ results } = await env.DB.prepare(sql).bind(email).all());
  }
  return results;
}

async function seedUser(env, email) {
  const cat = await env.DB.prepare(
    'INSERT OR IGNORE INTO categories (user_email, name) VALUES (?, ?) RETURNING id')
    .bind(email, DEFAULT_CATEGORY).first();
  if (!cat) return; // souběžný požadavek už seedoval
  const stmt = env.DB.prepare('INSERT INTO words (category_id, en, cs) VALUES (?, ?, ?)');
  await env.DB.batch(DEFAULT_WORDS.map(([en, cs]) => stmt.bind(cat.id, en, cs)));
}

async function createCategory(env, email, data) {
  const name = str(data.name, 'name', LIMITS.name, true);
  const row = await env.DB.prepare(
    'INSERT OR IGNORE INTO categories (user_email, name) VALUES (?, ?) RETURNING id, name')
    .bind(email, name).first();
  if (!row) throw new HttpError(409, 'Category already exists');
  return { ...row, word_count: 0 };
}

async function renameCategory(env, email, id, data) {
  const name = str(data.name, 'name', LIMITS.name, true);
  const clash = await env.DB.prepare(
    'SELECT id FROM categories WHERE user_email = ? AND name = ? AND id <> ?').bind(email, name, id).first();
  if (clash) throw new HttpError(409, 'Category already exists');
  const row = await env.DB.prepare(
    'UPDATE categories SET name = ? WHERE id = ? AND user_email = ? RETURNING id, name')
    .bind(name, id, email).first();
  if (!row) throw new HttpError(404, 'Category not found');
  return row;
}

async function deleteCategory(env, email, id) {
  await ownCategory(env, email, id);
  // Explicitně smažeme slova (nespoléháme jen na ON DELETE CASCADE).
  await env.DB.batch([
    env.DB.prepare('DELETE FROM words WHERE category_id = ?').bind(id),
    env.DB.prepare('DELETE FROM categories WHERE id = ? AND user_email = ?').bind(id, email),
  ]);
  return { ok: true };
}

async function ownCategory(env, email, id) {
  const row = await env.DB.prepare('SELECT id FROM categories WHERE id = ? AND user_email = ?')
    .bind(Number(id), email).first();
  if (!row) throw new HttpError(404, 'Category not found');
  return row;
}

/* ───────── words ───────── */

async function listWords(env, email, categoryParam) {
  const ids = String(categoryParam || '').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 90);
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT w.id, w.category_id, w.en, w.cs, w.description
     FROM words w JOIN categories c ON c.id = w.category_id
     WHERE c.user_email = ? AND w.category_id IN (${ph})
     ORDER BY w.id`).bind(email, ...ids).all();
  return results;
}

function wordFields(data, partial = false) {
  const out = {};
  if (!partial || data.en !== undefined) out.en = str(data.en, 'en', LIMITS.en, true);
  if (!partial || data.cs !== undefined) out.cs = str(data.cs, 'cs', LIMITS.cs, true);
  if (!partial || data.description !== undefined) {
    out.description = str(data.description, 'description', LIMITS.description, false) || null;
  }
  return out;
}

async function createWord(env, email, data) {
  await ownCategory(env, email, data.category_id);
  const f = wordFields(data);
  return env.DB.prepare(
    `INSERT INTO words (category_id, en, cs, description) VALUES (?, ?, ?, ?)
     RETURNING id, category_id, en, cs, description`)
    .bind(Number(data.category_id), f.en, f.cs, f.description).first();
}

async function bulkWords(env, email, data) {
  await ownCategory(env, email, data.category_id);
  if (!Array.isArray(data.lines) || !data.lines.length) throw new HttpError(400, 'lines must be a non-empty array');
  if (data.lines.length > LIMITS.bulk) throw new HttpError(400, `Max ${LIMITS.bulk} lines`);
  const rows = data.lines.map(l => wordFields(l || {}));
  const stmt = env.DB.prepare('INSERT INTO words (category_id, en, cs, description) VALUES (?, ?, ?, ?)');
  await env.DB.batch(rows.map(r => stmt.bind(Number(data.category_id), r.en, r.cs, r.description)));
  return { inserted: rows.length };
}

async function ownWord(env, email, id) {
  const row = await env.DB.prepare(
    `SELECT w.id FROM words w JOIN categories c ON c.id = w.category_id
     WHERE w.id = ? AND c.user_email = ?`).bind(id, email).first();
  if (!row) throw new HttpError(404, 'Word not found');
}

async function updateWord(env, email, id, data) {
  await ownWord(env, email, id);
  const f = wordFields(data, true);
  if (data.category_id !== undefined) {
    await ownCategory(env, email, data.category_id);
    f.category_id = Number(data.category_id);
  }
  const keys = Object.keys(f);
  if (!keys.length) throw new HttpError(400, 'Nothing to update');
  return env.DB.prepare(
    `UPDATE words SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?
     RETURNING id, category_id, en, cs, description`)
    .bind(...keys.map(k => f[k]), id).first();
}

async function deleteWord(env, email, id) {
  await ownWord(env, email, id);
  await env.DB.prepare('DELETE FROM words WHERE id = ?').bind(id).run();
  return { ok: true };
}

/* ───────── helpers ───────── */

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function str(v, field, max, required) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
  v = v.trim();
  if (required && !v) throw new HttpError(400, `${field} is required`);
  if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max})`);
  return v;
}

async function body(request) {
  const ct = request.headers.get('Content-Type') || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected application/json');
  try {
    const data = await request.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
