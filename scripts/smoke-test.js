/* End-to-end check. Boots a throwaway copy of the app, runs a whole job through
   it the way a crew member would, and asserts the rules actually hold.
   Run it after deploying:  node scripts/smoke-test.js  */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobproof-test-'));
const PASSWORD = 'test-password';

// A real (tiny) JPEG, so the server's image validation is genuinely exercised.
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let passed = 0;
let failed = 0;
const ok = (label, condition, extra = '') => {
  if (condition) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

let cookie = '';
async function call(method, path, body, { raw = false } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DATA_DIR,
    ADMIN_PASSWORD: PASSWORD,
    PUBLIC_URL: BASE,
    SESSION_SECRET: 'test-secret',
    TWILIO_ACCOUNT_SID: '', TWILIO_AUTH_TOKEN: '', OWNER_PHONE: '', NOTIFY_WEBHOOK_URL: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));

async function waitForBoot() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(BASE + '/'); return true; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  return false;
}

function cleanup() {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
}

try {
  if (!await waitForBoot()) throw new Error('Server never came up');
  console.log('\nAuth');
  ok('rejects the wrong password', (await call('POST', '/api/login', { password: 'nope' })).status === 401);
  ok('dashboard is closed to strangers', (await call('GET', '/api/state')).status === 401);
  ok('accepts the right password', (await call('POST', '/api/login', { password: PASSWORD })).status === 200);

  const state = (await call('GET', '/api/state')).data;
  console.log('\nSetup');
  ok('starter checklists loaded', state.templates.length === 6, `saw ${state.templates.length}`);
  const waterLine = state.templates.find((t) => t.name === 'Water Line Installation');
  ok('water line checklist is there', !!waterLine);

  const crew = (await call('POST', '/api/crew', { name: 'Mike R', phone: '(555) 123-4567' })).data;
  ok('crew member saved with a normalized number', crew.phone === '+15551234567', crew.phone);
  ok('duplicate number is refused',
    (await call('POST', '/api/crew', { name: 'Other', phone: '555-123-4567' })).status === 400);

  console.log('\nAssigning a job');
  const job = (await call('POST', '/api/jobs', {
    templateId: waterLine.id, crewId: crew.id, address: '412 Hardy Rd', customer: 'J. Hardy',
  })).data;
  ok('job created', !!job.id);
  ok('link token is long enough to not be guessable', job.link.split('/j/')[1].length >= 20);
  ok('the text names the job and carries the link',
    job.smsBody.includes('Water Line') && job.smsBody.includes(job.link));

  const token = job.link.split('/j/')[1];
  const share = job.report.split('/r/')[1];

  console.log('\nThe crew member opens the link (no login)');
  const noCookie = await fetch(`${BASE}/api/job/${token}`);
  ok('opens with no session at all', noCookie.status === 200);
  let view = await noCookie.json();
  ok('sees the checklist', view.steps.length > 0);
  ok('gating hides the later steps', view.steps.filter((s) => s.locked).length > 0);
  ok('step 1 is open', view.steps[0].locked === false);

  console.log('\nThe rules hold');
  const early = await call('POST', `/api/job/${token}/photo`,
    { stepId: view.steps[6].id, dataUrl: JPEG });
  ok('cannot jump ahead to a locked step', early.status === 409, `got ${early.status}`);

  const emptySubmit = await call('POST', `/api/job/${token}/submit`);
  ok('cannot turn in an unfinished job', emptySubmit.status === 422);
  ok('and is told exactly what is missing', Array.isArray(emptySubmit.data.missing) && emptySubmit.data.missing.length > 0);

  const junk = await call('POST', `/api/job/${token}/photo`,
    { stepId: view.steps[0].id, dataUrl: 'not-an-image' });
  ok('junk uploads are rejected', junk.status === 400);

  console.log('\nWorking the list top to bottom');
  const answerFor = (step) => {
    switch (step.type) {
      case 'text': return 'Recorded during the smoke test';
      case 'number': return 42;
      case 'check': return true;
      case 'choice': return step.options[0];
      case 'signature': return 'J. Hardy';
      default: return null;
    }
  };

  let guard = 0;
  for (;;) {
    view = (await call('GET', `/api/job/${token}`)).data;
    const next = view.steps.find((s) => !s.locked && !s.complete && s.required !== false);
    if (!next || guard++ > 60) break;
    if (next.type === 'photo' || next.type === 'signature') {
      const need = next.type === 'signature' ? 1 : next.min;
      for (let i = 0; i < need; i++) {
        const res = await call('POST', `/api/job/${token}/photo`, {
          stepId: next.id, dataUrl: JPEG,
          capturedAt: Date.now() - (60 - guard) * 60000, // spread out like a real day
          originalAt: Date.now() - (60 - guard) * 60000,
          lat: 41.5 + Math.random() * 0.0004, lng: -93.6 + Math.random() * 0.0004, accuracy: 8,
        });
        if (res.status !== 200) { ok(`photo upload for "${next.label}"`, false, JSON.stringify(res.data)); break; }
      }
    }
    if (next.type !== 'photo') {
      const res = await call('POST', `/api/job/${token}/entry`, { stepId: next.id, value: answerFor(next) });
      if (res.status !== 200) ok(`entry for "${next.label}"`, false, JSON.stringify(res.data));
    }
  }

  view = (await call('GET', `/api/job/${token}`)).data;
  ok('every required step is satisfied', view.progress.done === view.progress.total,
    `${view.progress.done}/${view.progress.total}`);
  ok('photos are on file', view.progress.photoCount >= 10, `${view.progress.photoCount}`);
  ok('nothing is locked any more', view.steps.every((s) => !s.locked));

  console.log('\nTurning it in');
  const submit = await call('POST', `/api/job/${token}/submit`);
  ok('submit is accepted once complete', submit.status === 200, JSON.stringify(submit.data).slice(0, 120));
  ok('job reads as submitted', submit.data.status === 'submitted');
  ok('edits stop after submit',
    (await call('POST', `/api/job/${token}/entry`, { stepId: view.steps[1].id, value: 'late edit' })).status === 409);

  console.log('\nPhoto access control');
  const firstPhoto = view.steps.find((s) => s.photos.length)?.photos[0].photoId;
  ok('a stranger with no token is refused',
    (await fetch(`${BASE}/media/${firstPhoto}`)).status === 403);
  ok('the job link opens its own photos',
    (await fetch(`${BASE}/media/${firstPhoto}?t=${token}`)).status === 200);
  ok('a wrong token is refused',
    (await fetch(`${BASE}/media/${firstPhoto}?t=aaaaaaaaaaaaaaaaaaaaaa`)).status === 403);
  ok('the share link opens them', (await fetch(`${BASE}/media/${firstPhoto}?s=${share}`)).status === 200);
  ok('the office (signed in) opens them',
    (await call('GET', `/media/${firstPhoto}`, undefined, { raw: true })).status === 200);

  console.log('\nThe office side');
  const detail = (await call('GET', `/api/jobs/${job.id}`)).data;
  ok('shows as waiting on review', detail.status === 'submitted');
  ok('honest documentation raises no flags', detail.flags.filter((f) => f.level === 'warn').length === 0,
    JSON.stringify(detail.flags.map((f) => f.code)));
  ok('nothing outstanding', detail.missing.length === 0);

  const rep = await (await fetch(`${BASE}/api/report/${share}`)).json();
  ok('customer report renders without a login', !!rep.checklistName);
  ok('report leaks no phone numbers', !JSON.stringify(rep).includes('5551234567'));
  ok('report carries no crew link', !JSON.stringify(rep).includes(token));

  const sendBack = await call('POST', `/api/jobs/${job.id}/review`, { decision: 'reject', note: 'Need the meter pit' });
  ok('can be sent back with a reason', sendBack.status === 200 && sendBack.data.status === 'rejected');
  ok('sending back reopens it for the crew',
    (await call('POST', `/api/job/${token}/entry`,
      { stepId: view.steps[1].id, value: 'fixed' })).status === 200);
  ok('a send-back needs a reason',
    (await call('POST', `/api/jobs/${job.id}/review`, { decision: 'reject', note: '' })).status === 400);

  await call('POST', `/api/job/${token}/submit`);
  const approve = await call('POST', `/api/jobs/${job.id}/review`, { decision: 'approve', note: 'Looks good' });
  ok('can be approved', approve.status === 200 && approve.data.status === 'approved');

  console.log('\nDurability');
  const onDisk = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'store.json'), 'utf8'));
  ok('everything is written to disk', onDisk.jobs.length === 1 && onDisk.jobs[0].status === 'approved');
  const photoFiles = fs.readdirSync(path.join(DATA_DIR, 'photos'), { recursive: true })
    .filter((f) => String(f).endsWith('.jpg'));
  ok('photo files are on disk', photoFiles.length >= 10, `${photoFiles.length} files`);

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
} catch (err) {
  console.error('\nTest run crashed:', err);
  failed++;
} finally {
  cleanup();
  process.exit(failed === 0 ? 0 : 1);
}
