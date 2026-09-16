import { metresBetween } from './util.js';

/** A step counts as done only when it actually holds what it asked for. */
export function isStepComplete(step, entry) {
  if (!entry) return false;
  const photos = entry.photos || [];
  switch (step.type) {
    case 'photo':
      return photos.length >= (step.min || 1);
    case 'signature':
      return photos.length >= 1 && String(entry.value || '').trim().length > 0;
    case 'text':
      return String(entry.value ?? '').trim().length > 0;
    case 'number':
      return entry.value !== null && entry.value !== undefined && entry.value !== '' && Number.isFinite(Number(entry.value));
    case 'check':
      return entry.value === true;
    case 'choice':
      return Boolean(entry.value) && (step.options || []).includes(entry.value);
    default:
      return false;
  }
}

export function requiredSteps(job) {
  return (job.templateSnapshot?.steps || []).filter((s) => s.required !== false);
}

export function progress(job) {
  const steps = job.templateSnapshot?.steps || [];
  const required = steps.filter((s) => s.required !== false);
  const done = required.filter((s) => isStepComplete(s, job.entries?.[s.id])).length;
  return {
    done,
    total: required.length,
    pct: required.length ? Math.round((done / required.length) * 100) : 0,
    photoCount: steps.reduce((n, s) => n + (job.entries?.[s.id]?.photos?.length || 0), 0),
  };
}

/** What is still standing between this job and "submitted". */
export function missingSteps(job) {
  return requiredSteps(job)
    .filter((s) => !isStepComplete(s, job.entries?.[s.id]))
    .map((s) => {
      const have = job.entries?.[s.id]?.photos?.length || 0;
      return {
        stepId: s.id,
        label: s.label,
        reason: s.type === 'photo'
          ? `needs ${s.min} photo${s.min > 1 ? 's' : ''}, has ${have}`
          : 'not filled in',
      };
    });
}

/**
 * With gating on, a step stays locked until everything above it is done, so the
 * during-photos cannot be "caught up on" after the trench is already closed.
 */
export function unlockedThrough(job) {
  const steps = job.templateSnapshot?.steps || [];
  if (!job.templateSnapshot?.gated) return steps.length;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.required !== false && !isStepComplete(s, job.entries?.[s.id])) return i + 1;
  }
  return steps.length;
}

export function allPhotos(job) {
  const out = [];
  for (const step of job.templateSnapshot?.steps || []) {
    for (const p of job.entries?.[step.id]?.photos || []) {
      out.push({ ...p, stepId: step.id, stepLabel: step.label });
    }
  }
  return out.sort((a, b) => (a.receivedAt || 0) - (b.receivedAt || 0));
}

/**
 * Honest documentation looks a certain way: photos spread across the workday,
 * shot at the job site, from the camera. These flags catch the other kind.
 * They are signals for a human to look at, not accusations.
 */
export function integrityFlags(job) {
  const flags = [];
  const photos = allPhotos(job);
  if (!photos.length) return flags;

  const located = photos.filter((p) => typeof p.lat === 'number' && typeof p.lng === 'number');
  const missingGps = photos.length - located.length;
  if (missingGps > 0) {
    flags.push({
      level: missingGps === photos.length ? 'warn' : 'info',
      code: 'no_gps',
      text: `${missingGps} of ${photos.length} photos have no location. Location was turned off or denied on that phone.`,
    });
  }

  // Everything shot in one burst at the end of the day is a rebuild, not a record.
  const times = photos.map((p) => p.capturedAt || p.receivedAt).filter(Boolean).sort((a, b) => a - b);
  if (times.length >= 4) {
    const spanMin = (times[times.length - 1] - times[0]) / 60000;
    const jobMin = job.startedAt && job.submittedAt ? (job.submittedAt - job.startedAt) / 60000 : null;
    if (spanMin < 5 && (jobMin === null || jobMin > 45)) {
      flags.push({
        level: 'warn',
        code: 'burst',
        text: `All ${photos.length} photos were taken within ${Math.max(1, Math.round(spanMin))} minute(s) of each other, but the job ran ${jobMin ? Math.round(jobMin / 60) : '?'} hours. Before/during/after photos should be spread across the work.`,
      });
    }
  }

  // A file whose own timestamp predates the job came out of the camera roll.
  const stale = photos.filter((p) => p.originalAt && job.createdAt && p.originalAt < job.createdAt - 60 * 60 * 1000);
  if (stale.length) {
    flags.push({
      level: 'warn',
      code: 'stale_file',
      text: `${stale.length} photo(s) were originally taken before this job was even assigned — picked from the camera roll rather than shot on site.`,
    });
  }

  // Photos scattered across town did not all come from one job site. Needs 3+
  // to be meaningful: with only two, the midpoint is equally far from both.
  if (located.length >= 3) {
    const mid = {
      lat: median(located.map((p) => p.lat)),
      lng: median(located.map((p) => p.lng)),
    };
    const far = located
      .map((p) => ({ p, d: metresBetween(mid, { lat: p.lat, lng: p.lng }) }))
      .filter((x) => x.d > 500);
    if (far.length) {
      const worst = Math.max(...far.map((x) => x.d));
      flags.push({
        level: 'warn',
        code: 'off_site',
        text: `${far.length} photo(s) were taken up to ${(worst / 1000).toFixed(1)} km away from the rest. Check they belong to this job.`,
      });
    }
  }

  if (job.dueAt && job.submittedAt && job.submittedAt > job.dueAt) {
    const hrs = Math.round((job.submittedAt - job.dueAt) / 3600000);
    flags.push({ level: 'info', code: 'late', text: `Submitted ${hrs}h after the deadline.` });
  }

  return flags;
}

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export const STATUS_LABEL = {
  assigned: 'Not started',
  in_progress: 'In progress',
  submitted: 'Waiting on review',
  approved: 'Approved',
  rejected: 'Sent back',
};

/** True when the crew has had the job long enough that silence is a problem.
    Measured from the last thing they actually did, so a job stuck at 40% all
    afternoon counts as stalled just like one that was never opened. */
export function isOverdue(job, reminderHours = 4) {
  if (job.status === 'submitted' || job.status === 'approved') return false;
  if (job.dueAt && Date.now() > job.dueAt) return true;
  const since = job.lastActivityAt || job.startedAt || job.createdAt;
  return Date.now() - since > reminderHours * 3600000;
}
