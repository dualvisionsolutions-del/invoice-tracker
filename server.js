import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { db, load, save, photoFile, DATA_DIR } from './src/store.js';
import { SEED_TEMPLATES, normalizeTemplate } from './src/seed-templates.js';
import { json, text, readJson, parseCookies, hmac, safeEqual } from './src/util.js';
import { isOverdue, progress } from './src/jobs.js';
import { notifyOwner, config } from './src/notify.js';
import * as api from './src/api.js';
import { HttpError } from './src/api.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_DAYS = 30;

// ---------------------------------------------------------------- bootstrap

load();

if (!db().templates.length) {
  db().templates = SEED_TEMPLATES.map((t) => normalizeTemplate({ ...t, createdAt: Date.now() }));
  save();
  console.log(`[setup] Loaded ${db().templates.length} starter checklists.`);
}

/** Survives restarts so a redeploy doesn't sign you out. */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, 'session.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
const SECRET = sessionSecret();

// --------------------------------------------------------------------- auth

function makeSession() {
  const expires = Date.now() + SESSION_DAYS * 86400000;
  return `${expires}.${hmac(SECRET, expires)}`;
}

function validSession(value) {
  if (!value) return false;
  const [expires, sig] = String(value).split('.');
  if (!expires || !sig) return false;
  if (Number(expires) < Date.now()) return false;
  return safeEqual(sig, hmac(SECRET, expires));
}

const isAdmin = (req) => validSession(parseCookies(req).dvs_session);

function requireAdmin(req) {
  if (!isAdmin(req)) throw new HttpError(401, 'Sign in to continue.');
}

// ------------------------------------------------------------ rate limiting

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.reset) {
    hits.set(key, { count: 1, reset: now + windowMs });
    return true;
  }
  rec.count += 1;
  return rec.count <= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60000).unref();

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

// ------------------------------------------------------------ static assets

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function serveStatic(res, relPath, { cache = false } = {}) {
  const full = path.resolve(PUBLIC, relPath);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full)) return false;
  const body = await fsp.readFile(full);
  res.writeHead(200, {
    'content-type': MIME[path.extname(full)] || 'application/octet-stream',
    'content-length': body.length,
    'cache-control': cache ? 'public, max-age=300' : 'no-cache',
  });
  res.end(body);
  return true;
}

// ------------------------------------------------------------------ routing

const ROUTES = [];
const route = (method, pattern, handler, opts = {}) =>
  ROUTES.push({ method, parts: pattern.split('/').filter(Boolean), handler, ...opts });

function match(req, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  for (const r of ROUTES) {
    if (r.method !== req.method) continue;
    if (r.parts.length !== parts.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      const spec = r.parts[i];
      if (spec.startsWith(':')) params[spec.slice(1)] = decodeURIComponent(parts[i]);
      else if (spec !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

// ---- pages ----

route('GET', '/', async (req, res) => {
  if (!isAdmin(req)) return serveStatic(res, 'login.html');
  return serveStatic(res, 'dashboard.html');
});
route('GET', '/j/:token', async (req, res) => serveStatic(res, 'worker.html'));
route('GET', '/r/:token', async (req, res) => serveStatic(res, 'report.html'));

// ---- auth ----

route('POST', '/api/login', async (req, res) => {
  const ip = clientIp(req);
  if (!rateLimit(`login:${ip}`, 8, 10 * 60000)) {
    throw new HttpError(429, 'Too many tries. Wait a few minutes.');
  }
  const { password } = await readJson(req, 4096);
  if (!ADMIN_PASSWORD) {
    throw new HttpError(500, 'No ADMIN_PASSWORD is set on the server. Set one and restart.');
  }
  const given = crypto.createHash('sha256').update(String(password || '')).digest('hex');
  const want = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest('hex');
  if (!safeEqual(given, want)) throw new HttpError(401, 'Wrong password.');
  res.setHeader('set-cookie',
    `dvs_session=${makeSession()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}` +
    (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
  json(res, 200, { ok: true });
});

route('POST', '/api/logout', async (req, res) => {
  res.setHeader('set-cookie', 'dvs_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
});

// ---- crew (token links, no login) ----

route('GET', '/api/job/:token', async (req, res, { token }) => json(res, 200, api.getCrewJob(token)));
route('POST', '/api/job/:token/start', async (req, res, { token }) => json(res, 200, await api.startJob(token)));
route('POST', '/api/job/:token/entry', async (req, res, { token }) =>
  json(res, 200, await api.saveEntry(token, await readJson(req, 64 * 1024))));

route('POST', '/api/job/:token/photo', async (req, res, { token }) => {
  if (!rateLimit(`photo:${token}`, 400, 3600000)) {
    throw new HttpError(429, 'That is a lot of photos. Give it a minute.');
  }
  json(res, 200, await api.addPhoto(token, await readJson(req)));
});

route('POST', '/api/job/:token/photo/:photoId/delete', async (req, res, { token, photoId }) =>
  json(res, 200, await api.removePhoto(token, photoId)));
route('POST', '/api/job/:token/submit', async (req, res, { token }) => json(res, 200, await api.submitJob(token)));
route('POST', '/api/job/:token/override', async (req, res, { token }) =>
  json(res, 200, await api.requestOverride(token, await readJson(req, 8192))));

// ---- report ----

route('GET', '/api/report/:token', async (req, res, { token }) => json(res, 200, api.reportView(token)));

// ---- photos ----

route('GET', '/media/:photoId', async (req, res, { photoId }, url) => {
  const photo = api.resolvePhoto(photoId, {
    jobToken: url.searchParams.get('t'),
    shareToken: url.searchParams.get('s'),
    isAdmin: isAdmin(req),
  });
  const file = photoFile(photo.relPath);
  if (!file) throw new HttpError(404, 'Photo file is missing from disk.');
  const stat = await fsp.stat(file);
  if (req.headers['if-none-match'] === `"${photo.sha256}"`) {
    res.writeHead(304); res.end(); return;
  }
  res.writeHead(200, {
    'content-type': 'image/jpeg',
    'content-length': stat.size,
    'cache-control': 'private, max-age=86400',
    etag: `"${photo.sha256}"`,
  });
  fs.createReadStream(file).pipe(res);
});

// ---- admin ----

const admin = (method, pattern, handler) =>
  route(method, pattern, async (req, res, params, url) => {
    requireAdmin(req);
    return handler(req, res, params, url);
  });

admin('GET', '/api/state', async (req, res) => json(res, 200, api.adminState()));
admin('GET', '/api/jobs/:id', async (req, res, { id }) => {
  const job = db().jobs.find((j) => j.id === id);
  if (!job) throw new HttpError(404, 'Job not found');
  json(res, 200, api.adminJobDetail(job));
});
admin('POST', '/api/jobs', async (req, res) => json(res, 200, api.createJob(await readJson(req, 64 * 1024))));
admin('POST', '/api/jobs/:id/send', async (req, res, { id }) => json(res, 200, await api.sendJobLink(id)));
admin('POST', '/api/jobs/:id/remind', async (req, res, { id }) => json(res, 200, await api.remindJob(id)));
admin('POST', '/api/jobs/:id/review', async (req, res, { id }) =>
  json(res, 200, await api.reviewJob(id, await readJson(req, 8192))));
admin('POST', '/api/jobs/:id/delete', async (req, res, { id }) => json(res, 200, await api.deleteJob(id)));

admin('GET', '/api/templates/:id', async (req, res, { id }) => json(res, 200, api.getTemplate(id)));
admin('POST', '/api/templates', async (req, res) => json(res, 200, api.upsertTemplate(await readJson(req, 256 * 1024))));
admin('POST', '/api/templates/:id', async (req, res, { id }) =>
  json(res, 200, api.upsertTemplate(await readJson(req, 256 * 1024), id)));
admin('POST', '/api/templates/:id/archive', async (req, res, { id }) => json(res, 200, api.archiveTemplate(id)));

admin('POST', '/api/jobs/:id/override', async (req, res, { id }) =>
  json(res, 200, await api.decideOverride(id, await readJson(req, 8192))));

admin('POST', '/api/code-packs/:id/install', async (req, res, { id }) =>
  json(res, 200, api.installCodePack(id)));
admin('POST', '/api/jurisdictions', async (req, res) =>
  json(res, 200, api.upsertJurisdiction(await readJson(req, 8192))));
admin('POST', '/api/jurisdictions/:id', async (req, res, { id }) =>
  json(res, 200, api.upsertJurisdiction(await readJson(req, 8192), id)));
admin('POST', '/api/jurisdictions/:id/archive', async (req, res, { id }) =>
  json(res, 200, api.archiveJurisdiction(id)));
admin('POST', '/api/jurisdictions/:id/starter-rules', async (req, res, { id }) =>
  json(res, 200, api.loadStarterRules(id)));

admin('POST', '/api/code-rules', async (req, res) =>
  json(res, 200, api.upsertCodeRule(await readJson(req, 32 * 1024))));
admin('POST', '/api/code-rules/:id', async (req, res, { id }) =>
  json(res, 200, api.upsertCodeRule(await readJson(req, 32 * 1024), id)));
admin('POST', '/api/code-rules/:id/verify', async (req, res, { id }) =>
  json(res, 200, api.verifyCodeRule(id, await readJson(req, 8192))));
admin('POST', '/api/code-rules/:id/archive', async (req, res, { id }) =>
  json(res, 200, api.archiveCodeRule(id)));

admin('POST', '/api/crew', async (req, res) => json(res, 200, api.upsertCrew(await readJson(req, 8192))));
admin('POST', '/api/crew/:id/archive', async (req, res, { id }) => json(res, 200, api.archiveCrew(id)));
admin('POST', '/api/settings', async (req, res) => json(res, 200, api.saveSettings(await readJson(req, 8192))));
admin('POST', '/api/activity/read', async (req, res) => json(res, 200, api.markActivityRead()));

// ------------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');

  try {
    const hit = match(req, url);
    if (hit) return await hit.route.handler(req, res, hit.params, url);

    if (req.method === 'GET' && await serveStatic(res, url.pathname.replace(/^\/+/, ''), { cache: true })) return;

    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'No such endpoint' });
    return text(res, 404, 'Not found');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[error] ${req.method} ${url.pathname}:`, err);
    if (res.headersSent) return res.end();

    // Validation errors on submit carry a JSON payload listing what's missing.
    let payload = { error: err.message || 'Something went wrong' };
    if (status === 422) {
      try { payload = JSON.parse(err.message); } catch { /* keep the plain message */ }
    }
    return json(res, status, payload);
  }
});

// ------------------------------------------------------- overdue nudge timer

const REMINDER_INTERVAL = 15 * 60000;
setInterval(async () => {
  const cooldown = 6 * 3600000;
  for (const job of db().jobs) {
    if (!isOverdue(job, db().settings.reminderHours)) continue;
    if (job.remindedAt && Date.now() - job.remindedAt < cooldown) continue;
    job.remindedAt = Date.now();
    save();
    await notifyOwner(job.status === 'assigned' ? 'overdue' : 'stalled', job);
  }
}, REMINDER_INTERVAL).unref();

server.listen(PORT, () => {
  const jobs = db().jobs.length;
  console.log(`\n  ${db().settings.companyName} job checklists`);
  console.log(`  ${config.publicUrl}`);
  console.log(`  ${db().templates.length} checklists · ${jobs} job${jobs === 1 ? '' : 's'} on file`);
  if (!ADMIN_PASSWORD) console.log('  !! ADMIN_PASSWORD is not set — the dashboard cannot be opened.');
  if (!config.twilio) console.log('  ·  Texting: manual (tap-to-text). Add Twilio keys to send automatically.');
  else console.log('  ·  Texting: Twilio connected.');
  console.log('');
});

export { server };
