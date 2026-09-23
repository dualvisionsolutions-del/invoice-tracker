import { logActivity, db } from './store.js';
import { prettyPhone } from './util.js';
import { progress } from './jobs.js';

export const config = {
  get publicUrl() {
    return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
  },
  get twilio() {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    return sid && token && from ? { sid, token, from } : null;
  },
  get ownerPhone() {
    return process.env.OWNER_PHONE || db().settings.ownerPhone || '';
  },
  get webhook() {
    return process.env.NOTIFY_WEBHOOK_URL || db().settings.notifyWebhook || '';
  },
};

export const jobLink = (job) => `${config.publicUrl}/j/${job.token}`;
export const reportLink = (job) => `${config.publicUrl}/r/${job.shareToken}`;

/** The text the crew member gets. Short - it has to read well on a lock screen. */
export function crewMessage(job) {
  const company = db().settings.companyName || 'DVS';
  const where = job.address ? ` at ${job.address}` : '';
  return `${company}: ${job.templateSnapshot.name}${where}.\n`
    + `Open this on your phone and work down the list. It takes photos as you go:\n`
    + `${jobLink(job)}\n`
    + `No app or login needed. The job isn't closed out until the list is done.`;
}

export async function sendSms(to, body) {
  const tw = config.twilio;
  if (!tw) return { sent: false, reason: 'Twilio is not configured' };
  if (!to) return { sent: false, reason: 'No phone number on file' };
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${tw.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${tw.sid}:${tw.token}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: tw.from, Body: body }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error('[sms] Twilio rejected the message:', res.status, detail.slice(0, 300));
      return { sent: false, reason: `Twilio returned ${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error('[sms] send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

async function postWebhook(payload) {
  const url = config.webhook;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    console.error('[webhook] failed:', err.message);
  }
}

const OWNER_TEXT = {
  started: (job) => `${job.assignedName} started ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''}.`,
  submitted: (job) => {
    const p = progress(job);
    return `DONE: ${job.assignedName} finished ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''} — ${p.photoCount} photos. Review: ${reportLink(job)}`;
  },
  overdue: (job) => `NOT STARTED: ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''} was sent to ${job.assignedName} and still hasn't been opened.`,
  code_violation: (job, detail) =>
    `CODE ISSUE on ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''} — ${detail}. `
    + `${job.assignedName} is on site now and cannot close the job until it is fixed or you approve a variance.`,
  override_requested: (job, detail) =>
    `VARIANCE REQUESTED by ${job.assignedName} on ${job.templateSnapshot.name}${job.address ? ` at ${job.address}` : ''} — ${detail}`,
  stalled: (job) => {
    const p = progress(job);
    return `STALLED: ${job.assignedName} is ${p.pct}% through ${job.templateSnapshot.name} and hasn't touched it in a while.`;
  },
};

/**
 * Every notable event lands in the dashboard feed no matter what. SMS and the
 * webhook are extra channels on top, so nothing is ever lost to a bad API key.
 */
export async function notifyOwner(kind, job, { force = false, detail = '' } = {}) {
  const build = OWNER_TEXT[kind];
  if (!build) return;
  const message = build(job, detail);

  logActivity(kind, job.id, message, { jobToken: job.token, share: job.shareToken });

  // A code violation is the one that has to reach a phone immediately: the
  // trench is open right now and it is cheap to fix right now.
  const loud = force || kind === 'submitted' || kind === 'overdue'
    || kind === 'code_violation' || kind === 'override_requested';
  if (loud && config.ownerPhone) await sendSms(config.ownerPhone, message);

  await postWebhook({
    event: kind,
    at: new Date().toISOString(),
    message,
    job: {
      id: job.id,
      title: job.title,
      checklist: job.templateSnapshot.name,
      customer: job.customer || '',
      address: job.address || '',
      assignedTo: job.assignedName,
      assignedPhone: prettyPhone(job.assignedPhone),
      status: job.status,
      progress: progress(job),
      reportUrl: reportLink(job),
    },
  });
}
