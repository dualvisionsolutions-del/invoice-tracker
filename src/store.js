import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { id } from './util.js';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'store.json');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');

const EMPTY = {
  version: 1,
  crew: [],
  templates: [],
  jurisdictions: [],
  codeRules: [],
  jobs: [],
  activity: [],
  settings: {
    companyName: 'Dual Vision Solutions',
    reminderHours: 4,
    requireGps: true,
  },
};

let state = null;
let writeTimer = null;
let writing = null;

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
}

export function load() {
  ensureDirs();
  if (!fs.existsSync(FILE)) {
    state = structuredClone(EMPTY);
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
    return state;
  }
  try {
    state = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    // Never start on a corrupt file and silently drop history - park it and shout.
    const backup = `${FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(FILE, backup);
    console.error(`[store] store.json is unreadable (${err.message}). Saved a copy at ${backup} and started empty.`);
    state = structuredClone(EMPTY);
  }
  for (const [key, value] of Object.entries(EMPTY)) {
    if (state[key] === undefined) state[key] = structuredClone(value);
  }
  state.settings = { ...EMPTY.settings, ...state.settings };
  return state;
}

export function db() {
  if (!state) load();
  return state;
}

/**
 * Writes are debounced but always land: tmp file + rename so a crash mid-write
 * can never leave a half-written store.json behind.
 */
export function save() {
  if (writeTimer) clearTimeout(writeTimer);
  writing = new Promise((resolve, reject) => {
    writeTimer = setTimeout(async () => {
      writeTimer = null;
      const tmp = `${FILE}.${process.pid}.tmp`;
      try {
        await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
        await fsp.rename(tmp, FILE);
        resolve();
      } catch (err) {
        console.error('[store] write failed:', err);
        reject(err);
      }
    }, 120);
  });
  return writing;
}

/** Call before responding to anything the crew must not lose (photos, submit). */
export async function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
    const tmp = `${FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2));
    await fsp.rename(tmp, FILE);
    return;
  }
  if (writing) await writing.catch(() => {});
}

// ---------- photos ----------

function photoPath(photoId, createdAt = Date.now()) {
  const d = new Date(createdAt);
  const bucket = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(PHOTO_DIR, bucket, `${photoId}.jpg`);
}

export async function writePhoto(buffer, createdAt) {
  const photoId = id(20);
  const dest = photoPath(photoId, createdAt);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.writeFile(dest, buffer);
  return {
    photoId,
    relPath: path.relative(DATA_DIR, dest),
    bytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16),
  };
}

export function photoFile(relPath) {
  // relPath comes from our own records, but resolve and re-check anyway so a
  // doctored store.json can't be used to read files outside the data folder.
  const full = path.resolve(DATA_DIR, relPath);
  if (!full.startsWith(path.resolve(PHOTO_DIR))) return null;
  return fs.existsSync(full) ? full : null;
}

export async function deletePhotoFile(relPath) {
  const full = photoFile(relPath);
  if (full) await fsp.unlink(full).catch(() => {});
}

// ---------- lookups ----------

export const findJobByToken = (token) => db().jobs.find((j) => j.token === token) || null;
export const findJobByShare = (token) => db().jobs.find((j) => j.shareToken === token) || null;
export const findJob = (jobId) => db().jobs.find((j) => j.id === jobId) || null;
export const findTemplate = (tplId) => db().templates.find((t) => t.id === tplId) || null;
export const findJurisdiction = (jid) => db().jurisdictions.find((j) => j.id === jid) || null;
export const findCodeRule = (rid) => db().codeRules.find((r) => r.id === rid) || null;

export function logActivity(type, jobId, message, meta = {}) {
  const entry = { id: id(10), at: Date.now(), type, jobId, message, meta, read: false };
  db().activity.unshift(entry);
  if (db().activity.length > 800) db().activity.length = 800;
  save();
  return entry;
}

export { DATA_DIR, PHOTO_DIR, FILE };
