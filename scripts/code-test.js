/* Proves the code-rule engine behaves the way a contractor needs it to:
   nothing enforces until a person signs off on it, an out-of-code measurement
   is recorded honestly but stops the job, and the rules a job was assigned
   under never change underneath it.   node scripts/code-test.js  */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 3800 + Math.floor(Math.random() * 180);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'jobproof-code-'));
const PASSWORD = 'test-password';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

let passed = 0, failed = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

let cookie = '';
async function call(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const crew = (method, p, body) => fetch(BASE + p, {
  method, headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR, ADMIN_PASSWORD: PASSWORD,
         PUBLIC_URL: BASE, SESSION_SECRET: 'x', TWILIO_ACCOUNT_SID: '', OWNER_PHONE: '', NOTIFY_WEBHOOK_URL: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => console.error('[server]', d.toString().trim()));

try {
  for (let i = 0; i < 60; i++) { try { await fetch(BASE); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
  await call('POST', '/api/login', { password: PASSWORD });
  const state = (await call('GET', '/api/state')).data;
  const waterLine = state.templates.find((t) => t.name === 'Water Line Installation');
  const member = (await call('POST', '/api/crew', { name: 'Mike R', phone: '5551234567' })).data;

  console.log('\nPack and starter data are well formed');
  {
    const { CODE_PACKS } = await import('../src/code-packs.js');
    const { SEED_CODE_RULES } = await import('../src/seed-codes.js');
    let clash = null;
    for (const pack of Object.values(CODE_PACKS)) {
      const seen = new Set();
      for (const r of pack.rules) {
        const key = `${r.jurisdiction}::${r.title}`;
        if (seen.has(key)) clash = `${pack.id} ${key}`;
        seen.add(key);
      }
    }
    // Rules are deduped by title on re-install, so a repeated title silently
    // drops one. Catch it here rather than in somebody's trench.
    ok('no two pack rules share a title within one jurisdiction', !clash, clash || '');
    const seedTitles = SEED_CODE_RULES.map((r) => r.title);
    ok('no two starter rules share a title', new Set(seedTitles).size === seedTitles.length);
  }

  console.log('\nNothing is invented');
  const jur = (await call('POST', '/api/jurisdictions',
    { state: 'IA', county: 'Polk', codeBase: 'whatever the state adopted' })).data;
  ok('jurisdiction created', jur.id && jur.name === 'Polk County, IA', jur.name);

  const loaded = (await call('POST', `/api/jurisdictions/${jur.id}/starter-rules`)).data;
  ok('starter rules load', loaded.added === 12, `added ${loaded.added}`);

  let rules = (await call('GET', '/api/state')).data.codeRules;
  ok('every starter rule ships unverified', rules.every((r) => !r.verified));
  ok('none of them enforce anything yet', rules.every((r) => !r.enforceable));
  ok('none ship with a value filled in',
    rules.every((r) => r.check.min == null && r.check.max == null));
  ok('each one says where to find the real number',
    rules.every((r) => (r.lookupHint || '').length > 30));

  console.log('\nUnverified rules stay out of the crew\'s way');
  const job1 = (await call('POST', '/api/jobs',
    { templateId: waterLine.id, crewId: member.id, address: '1 Test St', jurisdictionId: jur.id })).data;
  const view1 = (await crew('GET', `/api/job/${job1.token}`)).data;
  const codeSteps1 = view1.steps.filter((s) => s.codeRule);
  const injected1 = view1.steps.filter((s) => s.id.startsWith('code_'));
  ok('unverified rules still attach, so the office can see them', codeSteps1.length > 0, `${codeSteps1.length} attached`);
  ok('but none of them make a step required',
    injected1.length > 0 && injected1.every((s) => s.required === false), `${injected1.length} injected`);
  ok('an unverified rule never makes a step required that was not already',
    codeSteps1.filter((s) => s.required).every((s) => !s.id.startsWith('code_')));
  ok('crew sees them marked as unconfirmed', codeSteps1.every((s) => !s.codeRule.enforceable));
  ok('and nothing about the job is blocked', view1.code.fail === 0);

  console.log('\nThe sign-off is what gives a rule teeth');
  const depthRule = rules.find((r) => r.title === 'Minimum cover over water service');
  const noValue = await call('POST', `/api/code-rules/${depthRule.id}/verify`, { verifiedBy: 'Owner' });
  ok('cannot confirm a rule with no value in it', noValue.status === 400, noValue.data.error);

  await call('POST', `/api/code-rules/${depthRule.id}`, {
    jurisdictionId: jur.id, title: depthRule.title, mode: 'bind', bindToStep: 'depth',
    citation: 'Local amendment, confirmed with inspector',
    check: { kind: 'min', unit: 'inches', min: 48 },
  });
  const noName = await call('POST', `/api/code-rules/${depthRule.id}/verify`, { verifiedBy: '' });
  ok('cannot confirm a rule anonymously', noName.status === 400);

  const verified = (await call('POST', `/api/code-rules/${depthRule.id}/verify`,
    { verifiedBy: 'R. Dual', verifiedSource: 'Called Polk County building dept' })).data;
  ok('confirmed rule records who and when', verified.verified && verified.verifiedBy === 'R. Dual' && verified.verifiedAt);

  console.log('\nAn out-of-code measurement stops the job');
  const job2 = (await call('POST', '/api/jobs',
    { templateId: waterLine.id, crewId: member.id, address: '2 Test St', jurisdictionId: jur.id })).data;
  const token = job2.token;
  let view = (await crew('GET', `/api/job/${token}`)).data;
  const depthStep = view.steps.find((s) => s.id === 'depth');
  ok('the rule now rides on the existing depth step', !!depthStep.codeRule);
  ok('and it is now required', depthStep.required === true);
  ok('the crew is shown the requirement in plain words',
    depthStep.codeRule.requirementText === 'Must be at least 48 inches', depthStep.codeRule.requirementText);
  ok('and the citation', depthStep.codeRule.citation.includes('Local amendment'));

  // walk the checklist to the depth step
  const answer = (s) => s.type === 'text' ? 'test' : s.type === 'number' ? 50
    : s.type === 'check' ? true : s.type === 'choice' ? s.options[0] : 'x';
  const advance = async (stopAt) => {
    for (let g = 0; g < 40; g++) {
      view = (await crew('GET', `/api/job/${token}`)).data;
      const next = view.steps.find((s) => !s.locked && !s.complete && s.required !== false);
      if (!next || next.id === stopAt) return next;
      if (next.type === 'photo' || next.type === 'signature') {
        for (let i = 0; i < (next.min || 1); i++) {
          await crew('POST', `/api/job/${token}/photo`, { stepId: next.id, dataUrl: JPEG, lat: 41.5, lng: -93.6 });
        }
      }
      if (next.type !== 'photo') await crew('POST', `/api/job/${token}/entry`, { stepId: next.id, value: answer(next) });
    }
    return null;
  };
  await advance('depth');

  const under = await crew('POST', `/api/job/${token}/entry`, { stepId: 'depth', value: 36 });
  ok('the honest measurement is still accepted and stored', under.status === 200,
    JSON.stringify(under.data).slice(0, 100));
  view = (await crew('GET', `/api/job/${token}`)).data;
  const depthNow = view.steps.find((s) => s.id === 'depth');
  ok('and it is recorded as 36, not silently changed', depthNow.value === 36);
  ok('the step reads as failing code', depthNow.code.state === 'fail', depthNow.code?.state);
  ok('the crew is told exactly why', depthNow.code.message.includes('36') && depthNow.code.message.includes('48'));
  ok('it does not count toward progress', depthNow.complete === true && view.progress.done < view.progress.total);

  const afterDepth = view.steps.findIndex((s) => s.id === 'depth') + 1;
  ok('the steps below it stay locked', view.steps[afterDepth].locked === true);

  const depthIdx = view.steps.findIndex((s) => s.id === 'depth');
  const lockedPhotoStep = view.steps.find((s, i) => i > depthIdx && s.type === 'photo' && s.locked);
  const blockedPhoto = await crew('POST', `/api/job/${token}/photo`,
    { stepId: lockedPhotoStep.id, dataUrl: JPEG });
  ok('and cannot be worked around by shooting ahead', blockedPhoto.status === 409,
    `${blockedPhoto.status} ${blockedPhoto.data.error || ''}`);

  const earlySubmit = await crew('POST', `/api/job/${token}/submit`);
  ok('the job cannot be turned in', earlySubmit.status === 422);
  ok('the refusal names the code failure',
    earlySubmit.data.codeFailures?.[0]?.message.includes('48'), JSON.stringify(earlySubmit.data).slice(0, 140));

  console.log('\nFixing it clears the block');
  await crew('POST', `/api/job/${token}/entry`, { stepId: 'depth', value: 52 });
  view = (await crew('GET', `/api/job/${token}`)).data;
  ok('a compliant measurement passes', view.steps.find((s) => s.id === 'depth').code.state === 'pass');
  ok('and unlocks what is below it', view.steps[afterDepth].locked === false);

  console.log('\nThe variance path — an honest way out, instead of a fake number');
  await crew('POST', `/api/job/${token}/entry`, { stepId: 'depth', value: 40 });
  const noReason = await crew('POST', `/api/job/${token}/override`, { stepId: 'depth', reason: '' });
  ok('a variance needs a reason', noReason.status === 400);

  await crew('POST', `/api/job/${token}/override`,
    { stepId: 'depth', reason: 'Solid rock at 40in, engineer approved insulated shallow bury' });
  let detail = (await call('GET', `/api/jobs/${job2.id}`)).data;
  ok('the office sees the request', detail.overrideRequests.length === 1);
  ok('the job is still blocked while it is pending', detail.code.fail === 1);

  const denied = await call('POST', `/api/jobs/${job2.id}/override`,
    { stepId: 'depth', decision: 'deny', note: 'Re-dig it' });
  ok('a denial leaves the job blocked', denied.data.code.fail === 1);

  await call('POST', `/api/jobs/${job2.id}/override`,
    { stepId: 'depth', decision: 'grant', note: 'Engineer letter on file, insulated' });
  view = (await crew('GET', `/api/job/${token}`)).data;
  ok('a granted variance unblocks the step', view.steps.find((s) => s.id === 'depth').code.state === 'waived');
  ok('and the reason rides along with it',
    view.steps.find((s) => s.id === 'depth').code.message.includes('Engineer letter'));

  await advance(null);
  const submitted = await crew('POST', `/api/job/${token}/submit`);
  ok('the job can now be turned in', submitted.status === 200, JSON.stringify(submitted.data).slice(0, 160));

  const report = await (await fetch(`${BASE}/api/report/${job2.shareToken}`)).json();
  const waived = report.codeFindings.find((f) => f.state === 'waived');
  ok('the report shows the variance rather than hiding it', !!waived && waived.waiverNote.includes('Engineer'));
  ok('the report never claims compliance on unconfirmed rules',
    report.codeFindings.every((f) => f.state !== 'unverified'));

  console.log('\nA job never changes underneath the crew');
  await call('POST', `/api/code-rules/${depthRule.id}`, {
    jurisdictionId: jur.id, title: depthRule.title, mode: 'bind', bindToStep: 'depth',
    citation: 'Changed later', check: { kind: 'min', unit: 'inches', min: 96 },
  });
  const frozen = (await crew('GET', `/api/job/${token}`)).data.steps.find((s) => s.id === 'depth');
  ok('the finished job still shows the rule it was worked under',
    frozen.codeRule.check.min === 48, `saw ${frozen.codeRule.check.min}`);
  const reRules = (await call('GET', '/api/state')).data.codeRules;
  ok('changing what a rule requires drops its sign-off',
    reRules.find((r) => r.id === depthRule.id).verified === false);

  console.log('\nState-level rules cascade down to counties');
  const pack = (await call('POST', '/api/code-packs/ky/install')).data;
  ok('Kentucky pack installs', pack.newJurisdictions === 3 && pack.newRules === 14,
    JSON.stringify(pack));

  const after = (await call('GET', '/api/state')).data;
  const kyState = after.jurisdictions.find((j) => j.state === 'KY' && !j.county);
  const grant = after.jurisdictions.find((j) => j.county === 'Grant');
  const pendleton = after.jurisdictions.find((j) => j.county === 'Pendleton');
  ok('state, Grant and Pendleton all created', !!kyState && !!grant && !!pendleton);

  const kyRules = after.codeRules.filter((r) => r.jurisdictionId === kyState.id);
  ok('the plumbing rules sit at the state level', kyRules.length >= 10, `${kyRules.length}`);
  ok('nothing from the pack is confirmed', after.codeRules.every((r) => !r.verified));
  ok('nothing from the pack carries a value',
    kyRules.every((r) => r.check.min == null && r.check.max == null));
  ok('every pack rule names the regulation to read',
    kyRules.every((r) => r.citation.length > 5));

  // confirm one state rule, then check a Grant County job picks it up
  const kyDepth = kyRules.find((r) => r.title === 'Minimum cover over water service');
  await call('POST', `/api/code-rules/${kyDepth.id}`, {
    jurisdictionId: kyState.id, title: kyDepth.title, mode: 'bind', bindToStep: 'depth',
    citation: kyDepth.citation, appliesTo: ['tpl_water_line'],
    check: { kind: 'min', unit: 'inches', min: 30 },
  });
  await call('POST', `/api/code-rules/${kyDepth.id}/verify`, { verifiedBy: 'R. Dual' });

  const grantJob = (await call('POST', '/api/jobs',
    { templateId: waterLine.id, crewId: member.id, address: 'Grant Co', jurisdictionId: grant.id })).data;
  const grantView = (await crew('GET', `/api/job/${grantJob.token}`)).data;
  const grantDepth = grantView.steps.find((s) => s.id === 'depth');
  ok('a Grant County job inherits the statewide rule',
    grantDepth.codeRule?.check?.min === 30, JSON.stringify(grantDepth.codeRule?.check));

  const pendJob = (await call('POST', '/api/jobs',
    { templateId: waterLine.id, crewId: member.id, address: 'Pendleton Co', jurisdictionId: pendleton.id })).data;
  const pendDepth = (await crew('GET', `/api/job/${pendJob.token}`)).data.steps.find((s) => s.id === 'depth');
  ok('and so does a Pendleton County job', pendDepth.codeRule?.check?.min === 30);

  const grantLocal = grantView.steps.filter((s) => s.codeRule?.citation.includes('Grant County'));
  const pendSteps = (await crew('GET', `/api/job/${pendJob.token}`)).data.steps;
  ok('Grant County\'s own right-of-way rule lands only on Grant jobs',
    grantLocal.length === 1 && !pendSteps.some((s) => s.codeRule?.citation.includes('Grant County')));

  ok('installing twice does not duplicate anything',
    (await call('POST', '/api/code-packs/ky/install')).data.newRules === 0);

  console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} — ${passed} passed, ${failed} failed\n`);
} catch (err) {
  console.error('\nTest run crashed:', err);
  failed++;
} finally {
  server.kill();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
}
