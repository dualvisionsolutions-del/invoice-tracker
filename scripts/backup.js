/* Bundles the whole data folder - checklists, jobs, every photo - into one
   dated .tar.gz you can copy anywhere.  node scripts/backup.js [destination]  */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const OUT_DIR = process.argv[2] || path.join(process.cwd(), 'backups');

if (!fs.existsSync(DATA_DIR)) {
  console.error(`Nothing to back up — no data folder at ${DATA_DIR}`);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const date = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const target = path.join(OUT_DIR, `jobproof-${date}.tar.gz`);

try {
  await run('tar', ['-czf', target, '-C', path.dirname(DATA_DIR), path.basename(DATA_DIR)]);
} catch (err) {
  console.error('Backup failed:', err.message);
  process.exit(1);
}

const store = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8'));
const mb = (fs.statSync(target).size / 1048576).toFixed(1);
console.log(`Backed up ${store.jobs.length} jobs and ${store.templates.length} checklists`);
console.log(`${target}  (${mb} MB)`);
console.log('\nKeep a copy somewhere that is not this server.');
