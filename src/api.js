import {
  db, save, flush, writePhoto, deletePhotoFile, logActivity,
  findJob, findJobByToken, findJobByShare, findTemplate,
} from './store.js';
import { id, linkToken, normalizePhone, prettyPhone } from './util.js';
import { normalizeTemplate } from './seed-templates.js';
import {
  progress, missingSteps, unlockedThrough, integrityFlags, allPhotos,
  isStepComplete, isOverdue, STATUS_LABEL,
} from './jobs.js';
import { notifyOwner, sendSms, crewMessage, jobLink, reportLink, config } from './notify.js';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => { throw new HttpError(400, msg); };
const notFound = (msg = 'Not found') => { throw new HttpError(404, msg); };

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

// ---------------------------------------------------------------- crew view

/** Everything the phone needs, and nothing that isn't the crew's business. */
export function crewView(job) {
  const steps = job.templateSnapshot.steps;
  const openThrough = unlockedThrough(job);
  return {
    token: job.token,
    title: job.title,
    customer: job.customer || '',
    address: job.address || '',
    siteNotes: job.siteNotes || '',
    assignedName: job.assignedName,
    checklistName: job.templateSnapshot.name,
    gated: !!job.templateSnapshot.gated,
    status: job.status,
    dueAt: job.dueAt || null,
    startedAt: job.startedAt || null,
    submittedAt: job.submittedAt || null,
    reviewNote: job.status === 'rejected' ? job.reviewNote || '' : '',
    companyName: db().settings.companyName,
    progress: progress(job),
    missing: missingSteps(job),
    steps: steps.map((s, i) => {
      const entry = job.entries[s.id] || {};
      return {
        ...s,
        locked: i >= openThrough,
        complete: isStepComplete(s, entry),
        value: entry.value ?? null,
        photos: (entry.photos || []).map((p) => ({
          photoId: p.photoId, capturedAt: p.capturedAt, lat: p.lat, lng: p.lng,
        })),
      };
    }),
  };
}

function adminJobRow(job) {
  return {
    id: job.id,
    token: job.token,
    shareToken: job.shareToken,
    title: job.title,
    customer: job.customer || '',
    address: job.address || '',
    checklistName: job.templateSnapshot.name,
    assignedName: job.assignedName,
    assignedPhone: prettyPhone(job.assignedPhone),
    status: job.status,
    statusLabel: STATUS_LABEL[job.status] || job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    submittedAt: job.submittedAt || null,
    dueAt: job.dueAt || null,
    lastActivityAt: job.lastActivityAt || job.createdAt,
    sentAt: job.sentAt || null,
    progress: progress(job),
    overdue: isOverdue(job, db().settings.reminderHours),
    flagCount: job.status === 'submitted' || job.status === 'approved'
      ? integrityFlags(job).filter((f) => f.level === 'warn').length : 0,
  };
}

export function adminJobDetail(job) {
  const steps = job.templateSnapshot.steps.map((s) => {
    const entry = job.entries[s.id] || {};
    return {
      ...s,
      complete: isStepComplete(s, entry),
      value: entry.value ?? null,
      updatedAt: entry.updatedAt || null,
      photos: (entry.photos || []).map((p) => ({
        photoId: p.photoId, capturedAt: p.capturedAt, receivedAt: p.receivedAt,
        originalAt: p.originalAt || null, lat: p.lat, lng: p.lng, accuracy: p.accuracy,
        bytes: p.bytes, sha256: p.sha256,
      })),
    };
  });
  return {
    ...adminJobRow(job),
    siteNotes: job.siteNotes || '',
    reviewNote: job.reviewNote || '',
    reviewedAt: job.reviewedAt || null,
    link: jobLink(job),
    report: reportLink(job),
    smsBody: crewMessage(job),
    steps,
    missing: missingSteps(job),
    flags: integrityFlags(job),
    events: job.events || [],
  };
}

// ------------------------------------------------------------- crew actions

export function getCrewJob(token) {
  const job = findJobByToken(token);
  if (!job) notFound('This job link is not valid. Check with the office.');
  return crewView(job);
}

function touch(job, event) {
  job.lastActivityAt = Date.now();
  if (event) {
    job.events = job.events || [];
    job.events.push({ at: Date.now(), ...event });
    if (job.events.length > 500) job.events.shift();
  }
}

export async function startJob(token) {
  const job = findJobByToken(token);
  if (!job) notFound();
  if (!job.startedAt) {
    job.startedAt = Date.now();
    job.status = 'in_progress';
    touch(job, { type: 'started' });
    save();
    await notifyOwner('started', job);
  }
  return crewView(job);
}

function assertEditable(job) {
  if (job.status === 'submitted') {
    throw new HttpError(409, 'This job has already been turned in. Call the office if something needs to change.');
  }
  if (job.status === 'approved') {
    throw new HttpError(409, 'This job is closed out.');
  }
}

function stepOf(job, stepId) {
  const step = job.templateSnapshot.steps.find((s) => s.id === stepId);
  if (!step) notFound('That checklist item no longer exists.');
  return step;
}

/** Gating is enforced here, not just hidden in the UI. */
function assertUnlocked(job, stepId) {
  const idx = job.templateSnapshot.steps.findIndex((s) => s.id === stepId);
  if (idx >= unlockedThrough(job)) {
    throw new HttpError(409, 'Finish the steps above this one first.');
  }
}

export async function saveEntry(token, { stepId, value }) {
  const job = findJobByToken(token);
  if (!job) notFound();
  assertEditable(job);
  const step = stepOf(job, stepId);
  assertUnlocked(job, stepId);

  let clean = value;
  if (step.type === 'number') {
    if (value === '' || value === null) clean = null;
    else {
      const n = Number(value);
      if (!Number.isFinite(n)) bad('That needs to be a number.');
      if (step.min != null && n < step.min) bad(`Has to be at least ${step.min}.`);
      if (step.max != null && n > step.max) bad(`Has to be ${step.max} or less.`);
      clean = n;
    }
  } else if (step.type === 'check') {
    clean = value === true;
  } else if (step.type === 'choice') {
    if (value && !(step.options || []).includes(value)) bad('Pick one of the listed options.');
  } else if (step.type === 'text' || step.type === 'signature') {
    clean = String(value ?? '').slice(0, 5000);
  }

  const entry = (job.entries[stepId] ||= { photos: [] });
  entry.value = clean;
  entry.updatedAt = Date.now();
  if (job.status === 'assigned') job.status = 'in_progress';
  if (!job.startedAt) job.startedAt = Date.now();
  touch(job);
  save();
  return crewView(job);
}

export async function addPhoto(token, payload) {
  const job = findJobByToken(token);
  if (!job) notFound();
  assertEditable(job);
  const { stepId, dataUrl, capturedAt, originalAt, lat, lng, accuracy, width, height } = payload;
  const step = stepOf(job, stepId);
  if (step.type !== 'photo' && step.type !== 'signature') bad('That step does not take photos.');
  assertUnlocked(job, stepId);

  const match = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!match) bad('That image did not come through. Try taking it again.');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length) bad('That image was empty. Try taking it again.');
  if (buffer.length > MAX_PHOTO_BYTES) bad('That image is too large.');

  const entry = (job.entries[stepId] ||= { photos: [] });
  entry.photos ||= [];
  const cap = step.type === 'signature' ? 1 : (step.max || 20);
  if (entry.photos.length >= cap) {
    throw new HttpError(409, `That step holds at most ${cap} photo${cap > 1 ? 's' : ''}.`);
  }

  const received = Date.now();
  const stored = await writePhoto(buffer, received);
  entry.photos.push({
    ...stored,
    capturedAt: Number(capturedAt) || received,
    originalAt: Number(originalAt) || null,
    receivedAt: received,
    lat: typeof lat === 'number' ? lat : null,
    lng: typeof lng === 'number' ? lng : null,
    accuracy: typeof accuracy === 'number' ? Math.round(accuracy) : null,
    width: Number(width) || null,
    height: Number(height) || null,
  });
  entry.updatedAt = received;

  if (job.status === 'assigned') job.status = 'in_progress';
  if (!job.startedAt) job.startedAt = received;
  touch(job, { type: 'photo', stepId });
  save();
  await flush(); // a photo is the one thing we must never lose
  return { ok: true, photoId: stored.photoId, job: crewView(job) };
}

export async function removePhoto(token, photoId) {
  const job = findJobByToken(token);
  if (!job) notFound();
  assertEditable(job);
  for (const [stepId, entry] of Object.entries(job.entries)) {
    const idx = (entry.photos || []).findIndex((p) => p.photoId === photoId);
    if (idx !== -1) {
      const [gone] = entry.photos.splice(idx, 1);
      await deletePhotoFile(gone.relPath);
      entry.updatedAt = Date.now();
      touch(job, { type: 'photo_removed', stepId });
      save();
      await flush();
      return crewView(job);
    }
  }
  notFound('That photo is already gone.');
}

/** The gate. A job cannot be turned in with required work missing - checked here, server side. */
export async function submitJob(token) {
  const job = findJobByToken(token);
  if (!job) notFound();
  if (job.status === 'submitted' || job.status === 'approved') return crewView(job);

  const missing = missingSteps(job);
  if (missing.length) {
    throw new HttpError(422, JSON.stringify({
      error: 'This job is not finished yet.',
      missing,
    }));
  }

  job.status = 'submitted';
  job.submittedAt = Date.now();
  touch(job, { type: 'submitted' });
  save();
  await flush();
  await notifyOwner('submitted', job);
  return crewView(job);
}

// ------------------------------------------------------------ admin actions

export function adminState() {
  const d = db();
  return {
    settings: d.settings,
    config: {
      publicUrl: config.publicUrl,
      twilioReady: !!config.twilio,
      ownerPhoneSet: !!config.ownerPhone,
      webhookSet: !!config.webhook,
    },
    crew: d.crew.filter((c) => !c.archived),
    templates: d.templates.filter((t) => !t.archived).map((t) => ({
      id: t.id, name: t.name, trade: t.trade, description: t.description,
      gated: t.gated, stepCount: t.steps.length,
      photoCount: t.steps.filter((s) => s.type === 'photo').reduce((a, s) => a + (s.min || 1), 0),
    })),
    jobs: d.jobs.map(adminJobRow).sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    activity: d.activity.slice(0, 60),
  };
}

export function getTemplate(tplId) {
  const tpl = findTemplate(tplId);
  if (!tpl) notFound('Checklist not found.');
  return tpl;
}

const STEP_TYPES = new Set(['photo', 'text', 'number', 'check', 'choice', 'signature']);

function sanitizeSteps(raw) {
  if (!Array.isArray(raw) || !raw.length) bad('A checklist needs at least one step.');
  const seen = new Set();
  return raw.map((s, i) => {
    const type = STEP_TYPES.has(s.type) ? s.type : 'text';
    let stepId = String(s.id || '').trim() || `step_${i + 1}`;
    while (seen.has(stepId)) stepId = `${stepId}_${id(3)}`;
    seen.add(stepId);
    const label = String(s.label || '').trim();
    if (!label) bad(`Step ${i + 1} needs a label.`);
    const step = {
      id: stepId,
      type,
      label: label.slice(0, 200),
      help: String(s.help || '').slice(0, 600),
      required: s.required !== false,
    };
    if (type === 'photo') {
      step.min = Math.min(20, Math.max(1, Number(s.min) || 1));
      step.max = Math.min(30, Math.max(step.min, Number(s.max) || 10));
      if (s.referenceStep) step.referenceStep = String(s.referenceStep);
    }
    if (type === 'choice') {
      step.options = (Array.isArray(s.options) ? s.options : [])
        .map((o) => String(o).trim()).filter(Boolean).slice(0, 12);
      if (step.options.length < 2) bad(`"${label}" needs at least two options.`);
    }
    if (type === 'number') {
      step.unit = String(s.unit || '').slice(0, 24);
      if (s.min !== '' && s.min != null) step.min = Number(s.min);
      if (s.max !== '' && s.max != null) step.max = Number(s.max);
    }
    if (type === 'text') {
      step.multiline = !!s.multiline;
      step.placeholder = String(s.placeholder || '').slice(0, 160);
    }
    return step;
  });
}

export function upsertTemplate(body, tplId) {
  const name = String(body.name || '').trim();
  if (!name) bad('Give the checklist a name.');
  const steps = sanitizeSteps(body.steps);
  const refs = new Set(steps.map((s) => s.id));
  for (const s of steps) if (s.referenceStep && !refs.has(s.referenceStep)) delete s.referenceStep;

  if (tplId) {
    const tpl = findTemplate(tplId);
    if (!tpl) notFound('Checklist not found.');
    Object.assign(tpl, {
      name, trade: String(body.trade || '').slice(0, 60),
      description: String(body.description || '').slice(0, 400),
      gated: !!body.gated, steps, updatedAt: Date.now(),
    });
    save();
    return tpl;
  }
  const tpl = normalizeTemplate({
    id: `tpl_${id(8)}`, name,
    trade: String(body.trade || '').slice(0, 60),
    description: String(body.description || '').slice(0, 400),
    gated: !!body.gated, steps, createdAt: Date.now(), updatedAt: Date.now(),
  });
  db().templates.push(tpl);
  save();
  return tpl;
}

export function archiveTemplate(tplId) {
  const tpl = findTemplate(tplId);
  if (!tpl) notFound();
  tpl.archived = true; // keep it: live jobs carry their own snapshot, but history stays readable
  save();
  return { ok: true };
}

export function upsertCrew(body) {
  const name = String(body.name || '').trim();
  if (!name) bad('Name is required.');
  const phone = normalizePhone(body.phone);
  if (!phone || phone.replace(/\D/g, '').length < 10) bad('Enter a full mobile number.');
  const existing = body.id ? db().crew.find((c) => c.id === body.id) : null;
  if (existing) {
    Object.assign(existing, { name, phone });
    save();
    return existing;
  }
  const dupe = db().crew.find((c) => c.phone === phone && !c.archived);
  if (dupe) bad(`${dupe.name} already has that number.`);
  const member = { id: `crew_${id(8)}`, name, phone, archived: false, createdAt: Date.now() };
  db().crew.push(member);
  save();
  return member;
}

export function archiveCrew(crewId) {
  const member = db().crew.find((c) => c.id === crewId);
  if (!member) notFound();
  member.archived = true;
  save();
  return { ok: true };
}

export function createJob(body) {
  const tpl = findTemplate(body.templateId);
  if (!tpl) bad('Pick a checklist.');

  let assignedName = String(body.assignedName || '').trim();
  let assignedPhone = normalizePhone(body.assignedPhone);
  if (body.crewId) {
    const member = db().crew.find((c) => c.id === body.crewId);
    if (!member) bad('That crew member is not on file.');
    assignedName = member.name;
    assignedPhone = member.phone;
  }
  if (!assignedName) bad('Who is this going to?');
  if (!assignedPhone) bad('A mobile number is required — that is where the link goes.');

  const address = String(body.address || '').trim();
  const job = {
    id: `job_${id(10)}`,
    token: linkToken(),
    shareToken: linkToken(),
    templateId: tpl.id,
    templateSnapshot: normalizeTemplate(structuredClone(tpl)), // frozen: editing the template later never rewrites history
    title: String(body.title || '').trim() || `${tpl.name}${address ? ` — ${address}` : ''}`,
    customer: String(body.customer || '').trim(),
    address,
    siteNotes: String(body.siteNotes || '').trim().slice(0, 1000),
    crewId: body.crewId || null,
    assignedName,
    assignedPhone,
    status: 'assigned',
    entries: {},
    events: [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    dueAt: body.dueAt ? new Date(body.dueAt).getTime() : null,
    remindedAt: null,
    sentAt: null,
  };
  if (job.dueAt && !Number.isFinite(job.dueAt)) job.dueAt = null;

  db().jobs.push(job);
  logActivity('created', job.id, `${job.templateSnapshot.name} assigned to ${assignedName}${address ? ` at ${address}` : ''}.`);
  save();
  return adminJobDetail(job);
}

/** Sends by Twilio if it's set up; otherwise hands back a tap-to-text link. */
export async function sendJobLink(jobId) {
  const job = findJob(jobId);
  if (!job) notFound();
  const body = crewMessage(job);
  const result = await sendSms(job.assignedPhone, body);
  if (result.sent) {
    job.sentAt = Date.now();
    touch(job, { type: 'sent' });
    logActivity('sent', job.id, `Link texted to ${job.assignedName} at ${prettyPhone(job.assignedPhone)}.`);
    save();
  }
  // The tap-to-text link is built by the browser: only it knows whether the
  // office is holding an iPhone (&body=) or an Android (?body=).
  return { ...result, phone: job.assignedPhone, body, link: jobLink(job) };
}

export async function remindJob(jobId) {
  const job = findJob(jobId);
  if (!job) notFound();
  const p = progress(job);
  const body = job.status === 'assigned'
    ? `Reminder from ${db().settings.companyName}: the checklist for ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''} hasn't been opened yet. ${jobLink(job)}`
    : `Reminder: you're ${p.pct}% through ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''}. Finish it before you leave the site: ${jobLink(job)}`;
  const result = await sendSms(job.assignedPhone, body);
  job.remindedAt = Date.now();
  logActivity('reminded', job.id, `Reminder ${result.sent ? 'texted' : 'prepared'} for ${job.assignedName}.`);
  save();
  return { ...result, phone: job.assignedPhone, body, link: jobLink(job) };
}

export async function reviewJob(jobId, { decision, note }) {
  const job = findJob(jobId);
  if (!job) notFound();
  if (job.status !== 'submitted' && job.status !== 'approved') {
    bad('That job has not been turned in yet.');
  }
  const cleanNote = String(note || '').trim().slice(0, 1000);
  if (decision === 'approve') {
    job.status = 'approved';
    job.reviewedAt = Date.now();
    job.reviewNote = cleanNote;
    logActivity('approved', job.id, `${job.templateSnapshot.name} approved.`);
  } else if (decision === 'reject') {
    if (!cleanNote) bad('Tell them what needs fixing.');
    job.status = 'rejected';
    job.reviewedAt = Date.now();
    job.reviewNote = cleanNote;
    job.submittedAt = null;
    logActivity('rejected', job.id, `Sent back to ${job.assignedName}: ${cleanNote}`);
    await sendSms(job.assignedPhone,
      `${db().settings.companyName}: your ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''} needs another look — ${cleanNote}\n${jobLink(job)}`);
  } else {
    bad('Unknown decision.');
  }
  touch(job, { type: decision });
  save();
  await flush();
  return adminJobDetail(job);
}

export async function deleteJob(jobId) {
  const d = db();
  const idx = d.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) notFound();
  const [job] = d.jobs.splice(idx, 1);
  for (const photo of allPhotos(job)) await deletePhotoFile(photo.relPath);
  d.activity = d.activity.filter((a) => a.jobId !== jobId);
  save();
  await flush();
  return { ok: true };
}

export function saveSettings(body) {
  const s = db().settings;
  if (body.companyName !== undefined) s.companyName = String(body.companyName).trim().slice(0, 80) || 'DVS';
  if (body.ownerPhone !== undefined) s.ownerPhone = normalizePhone(body.ownerPhone);
  if (body.notifyWebhook !== undefined) s.notifyWebhook = String(body.notifyWebhook).trim().slice(0, 500);
  if (body.reminderHours !== undefined) {
    s.reminderHours = Math.min(72, Math.max(1, Number(body.reminderHours) || 4));
  }
  save();
  return s;
}

export function markActivityRead() {
  for (const a of db().activity) a.read = true;
  save();
  return { ok: true };
}

/** Read-only view for a customer-facing report link. No tokens, no phone numbers. */
export function reportView(shareToken) {
  const job = findJobByShare(shareToken);
  if (!job) notFound('That report link is not valid.');
  return {
    companyName: db().settings.companyName,
    title: job.title,
    customer: job.customer || '',
    address: job.address || '',
    checklistName: job.templateSnapshot.name,
    performedBy: job.assignedName,
    status: job.status,
    statusLabel: STATUS_LABEL[job.status],
    startedAt: job.startedAt,
    submittedAt: job.submittedAt,
    progress: progress(job),
    shareToken,
    steps: job.templateSnapshot.steps.map((s) => {
      const entry = job.entries[s.id] || {};
      return {
        id: s.id, type: s.type, label: s.label, help: s.help,
        referenceStep: s.referenceStep || null,
        value: entry.value ?? null,
        complete: isStepComplete(s, entry),
        photos: (entry.photos || []).map((p) => ({
          photoId: p.photoId, capturedAt: p.capturedAt,
          hasGps: typeof p.lat === 'number', lat: p.lat, lng: p.lng,
        })),
      };
    }),
  };
}

/** Which job a photo belongs to, and who is allowed to look at it. */
export function resolvePhoto(photoId, { jobToken, shareToken, isAdmin }) {
  for (const job of db().jobs) {
    for (const entry of Object.values(job.entries || {})) {
      const photo = (entry.photos || []).find((p) => p.photoId === photoId);
      if (!photo) continue;
      const allowed = isAdmin || (jobToken && jobToken === job.token) || (shareToken && shareToken === job.shareToken);
      if (!allowed) throw new HttpError(403, 'Not allowed');
      return photo;
    }
  }
  notFound('Photo not found');
}

export { HttpError };
