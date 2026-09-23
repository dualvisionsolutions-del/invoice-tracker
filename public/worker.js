/* The field app. Assumptions it is built on:
   - one bar of signal, so photos get compressed hard before they go up
   - the phone may lose the network mid-job, so uploads queue in IndexedDB
     and survive the page being closed
   - the guy holding it has gloves on and the sun in his eyes */

const TOKEN = location.pathname.split('/')[2] || '';
const $ = (sel, root = document) => root.querySelector(sel);

let JOB = null;
let gpsFix = null;       // last known position, reused for up to 2 min
let submitting = false;
const reopened = new Set();  // finished steps the crew tapped back open

// ------------------------------------------------------------------- helpers

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ''; }, kind === 'bad' ? 5200 : 2800);
}

async function apiCall(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.payload = body;
    err.status = res.status;
    throw err;
  }
  return body;
}

const clock = (ts) => ts
  ? new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  : '';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ location

/** Best-effort. A denied prompt must never block the job. */
function getPosition({ maxAgeMs = 120000 } = {}) {
  if (gpsFix && Date.now() - gpsFix.at < maxAgeMs) return Promise.resolve(gpsFix);
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        gpsFix = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          at: Date.now(),
        };
        finish(gpsFix);
      },
      () => finish(null),
      { enableHighAccuracy: true, timeout: 7000, maximumAge: maxAgeMs },
    );
    setTimeout(() => finish(null), 7500); // never hang the camera on a slow fix
  });
}

// --------------------------------------------------------------- compression

const MAX_EDGE = 1600;
const QUALITY = 0.72;

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* older Safari: fall through */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not read that image'));
      el.src = url;
    });
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** A 9 MB phone photo comes out around 250 KB, which uploads on one bar. */
async function compress(file) {
  const src = await loadBitmap(file);
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
  if (!blob) throw new Error('Could not process that photo');
  return { blob, width: w, height: h };
}

const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(new Error('Could not read the photo'));
  reader.readAsDataURL(blob);
});

// ------------------------------------------------------- durable upload queue

const DB_NAME = 'dvs-jobproof';
const STORE = 'pending';
let idbPromise = null;

function idb() {
  if (idbPromise) return idbPromise;
  idbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: 'localId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(() => null); // private mode / blocked storage: fall back to memory
  return idbPromise;
}

const memoryQueue = new Map();

async function queueAdd(record) {
  const database = await idb();
  if (!database) { memoryQueue.set(record.localId, record); return; }
  await new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function queueAll() {
  const database = await idb();
  if (!database) return [...memoryQueue.values()].filter((r) => r.token === TOKEN);
  const rows = await new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }).catch(() => []);
  return rows.filter((r) => r.token === TOKEN);
}

async function queueDelete(localId) {
  const database = await idb();
  if (!database) { memoryQueue.delete(localId); return; }
  await new Promise((resolve) => {
    const tx = database.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(localId);
    tx.oncomplete = resolve;
    tx.onerror = resolve;
  });
}

let pumping = false;
let backoff = 0;

/** Drains the queue one photo at a time, retrying forever with backoff. */
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    for (;;) {
      const pending = await queueAll();
      if (!pending.length) { backoff = 0; break; }
      if (!navigator.onLine) break;

      const item = pending[0];
      try {
        const dataUrl = await blobToDataUrl(item.blob);
        const result = await apiCall(`/api/job/${TOKEN}/photo`, {
          method: 'POST',
          body: JSON.stringify({
            stepId: item.stepId,
            dataUrl,
            capturedAt: item.capturedAt,
            originalAt: item.originalAt,
            lat: item.lat,
            lng: item.lng,
            accuracy: item.accuracy,
            width: item.width,
            height: item.height,
          }),
        });
        await queueDelete(item.localId);
        JOB = result.job;
        backoff = 0;
        render();
      } catch (err) {
        // 4xx means the server will never accept it - drop it rather than retry forever.
        if (err.status >= 400 && err.status < 500) {
          await queueDelete(item.localId);
          toast(err.message, 'bad');
          render();
          continue;
        }
        backoff = Math.min(30000, backoff ? backoff * 2 : 2000);
        setTimeout(pump, backoff);
        break;
      }
    }
  } finally {
    pumping = false;
    renderPendingBanner();
  }
}

async function capturePhoto(stepId, file) {
  const originalAt = file.lastModified || null;
  const [{ blob, width, height }, position] = await Promise.all([compress(file), getPosition()]);
  const record = {
    localId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    token: TOKEN,
    stepId,
    blob,
    width,
    height,
    capturedAt: Date.now(),
    originalAt,
    lat: position?.lat ?? null,
    lng: position?.lng ?? null,
    accuracy: position?.accuracy ?? null,
  };
  await queueAdd(record);
  render();
  pump();
}

// -------------------------------------------------------------------- render

/**
 * What the crew is told about the code rule on a step. An unconfirmed rule is
 * deliberately worded as a note and never as a requirement - the office has not
 * checked it against the adopted code yet, so it carries no authority here.
 */
function codeBlock(step) {
  const rule = step.codeRule;
  if (!rule) return '';
  const cite = [rule.jurisdictionName, rule.citation].filter(Boolean).join(' · ');
  const citeLine = cite ? `<span class="cite">${esc(cite)}</span>` : '';

  if (!rule.enforceable) {
    return `<div class="code code--note">
      ${esc(rule.title)} — not confirmed by the office yet, so it is not a requirement on this job.
      ${citeLine}</div>`;
  }

  const state = step.code?.state;
  if (state === 'fail') {
    return `<div class="code code--fail">
      <span class="req">DOES NOT MEET CODE</span><br>${esc(step.code.message)}
      ${citeLine}
      <button class="btn btn--ghost btn--sm" style="margin-top:10px;width:100%"
              data-variance="${step.id}">Can't meet this — tell the office why</button>
    </div>`;
  }
  if (state === 'waived') {
    return `<div class="code code--waived">
      <span class="req">Variance approved by the office</span><br>${esc(step.code.message)}
      ${citeLine}</div>`;
  }
  if (state === 'pass') {
    return `<div class="code code--pass">✓ ${esc(step.code.message)}${citeLine}</div>`;
  }
  const pending = step.override?.status === 'requested'
    ? '<br><b>Variance requested — waiting on the office.</b>' : '';
  return `<div class="code code--rule">
    <span class="req">${esc(rule.requirementText)}</span>
    ${rule.plainLanguage ? `<br>${esc(rule.plainLanguage)}` : ''}${pending}
    ${citeLine}</div>`;
}

/** One-line recap shown on a folded-up step. */
function stepSummary(step) {
  const shots = step.photos.length;
  if (step.type === 'photo') return `${shots} photo${shots === 1 ? '' : 's'}`;
  if (step.type === 'signature') return 'Signed';
  if (step.type === 'check') return 'Confirmed';
  const value = String(step.value ?? '');
  return value.length > 24 ? `${value.slice(0, 24)}…` : value;
}

function stepStatusClass(step, index, activeIndex) {
  if (step.locked) return 'locked';
  if (step.code?.state === 'fail') return 'active codefail';
  if (step.complete) return 'done';
  return index === activeIndex ? 'active' : '';
}

function photoTile(photo, stepId) {
  return `<div class="shot">
    <img src="/media/${photo.photoId}?t=${encodeURIComponent(TOKEN)}" alt="" loading="lazy">
    <button class="x" data-del="${photo.photoId}" aria-label="Remove photo">&times;</button>
    <div class="stamp">${clock(photo.capturedAt)}${photo.lat ? ' · GPS' : ''}</div>
  </div>`;
}

function pendingTile(item) {
  const url = URL.createObjectURL(item.blob);
  return `<div class="shot pending">
    <img src="${url}" alt="" onload="URL.revokeObjectURL(this.src)">
    <div class="spin">SENDING…</div>
  </div>`;
}

let pendingByStep = {};

function renderStepBody(step) {
  const mine = pendingByStep[step.id] || [];

  if (step.type === 'photo' || step.type === 'signature') {
    const have = step.photos.length + mine.length;
    const need = step.type === 'signature' ? 1 : step.min;
    const full = have >= (step.type === 'signature' ? 1 : step.max);

    let html = '';

    if (step.referenceStep) {
      const ref = JOB.steps.find((s) => s.id === step.referenceStep);
      const refPhoto = ref?.photos?.[0];
      if (refPhoto) {
        html += `<div class="refshot">
          <img src="/media/${refPhoto.photoId}?t=${encodeURIComponent(TOKEN)}" alt="">
          <div class="small"><span class="bold">Match this angle.</span><br>Your BEFORE shot — stand in the same spot.</div>
        </div>`;
      }
    }

    // Once it's signed, show the signature rather than an empty pad they
    // can't use again (the step holds exactly one).
    if (step.type === 'signature' && !have) {
      html += `<canvas id="sigpad" data-step="${step.id}"></canvas>
        <div class="row" style="margin:10px 0">
          <button class="btn btn--ghost btn--sm" data-sigclear="1">Clear</button>
          <button class="btn btn--sm grow" data-sigsave="${step.id}">Save signature</button>
        </div>
        <label class="field"><span>Printed name</span>
          <input type="text" data-val="${step.id}" value="${esc(step.value || '')}" placeholder="Who signed?"></label>`;
    } else if (step.type === 'signature') {
      html += `<label class="field"><span>Printed name</span>
          <input type="text" data-val="${step.id}" value="${esc(step.value || '')}" placeholder="Who signed?"></label>`;
    }

    if (have) {
      html += `<div class="shots" style="margin-bottom:12px">
        ${step.photos.map((p) => photoTile(p, step.id)).join('')}
        ${mine.map(pendingTile).join('')}
      </div>`;
    }

    if (step.type === 'photo' && !full) {
      const remaining = Math.max(0, need - have);
      html += `<label class="btn btn--block ${have ? 'btn--ghost' : ''}" style="cursor:pointer">
        <input type="file" accept="image/*" capture="environment" multiple
               data-shoot="${step.id}" style="position:absolute;width:1px;height:1px;opacity:0">
        ${have ? `Add another photo` : `Take ${need > 1 ? need + ' photos' : 'photo'}`}
      </label>`;
      if (remaining > 0 && have > 0) {
        html += `<div class="small" style="margin-top:8px;color:var(--amber);font-weight:700">
          ${remaining} more photo${remaining > 1 ? 's' : ''} needed</div>`;
      }
    }
    return html;
  }

  if (step.type === 'text') {
    return step.multiline
      ? `<textarea data-val="${step.id}" placeholder="${esc(step.placeholder || '')}">${esc(step.value || '')}</textarea>`
      : `<input type="text" data-val="${step.id}" value="${esc(step.value || '')}" placeholder="${esc(step.placeholder || '')}">`;
  }

  if (step.type === 'number') {
    return `<div class="row">
      <input type="number" inputmode="decimal" data-val="${step.id}" value="${step.value ?? ''}" style="flex:1">
      ${step.unit ? `<span class="bold muted">${esc(step.unit)}</span>` : ''}
    </div>`;
  }

  if (step.type === 'check') {
    return `<label class="checkbox ${step.value ? 'sel' : ''}">
      <input type="checkbox" data-val="${step.id}" ${step.value ? 'checked' : ''}>
      <span>Yes — confirmed</span></label>`;
  }

  if (step.type === 'choice') {
    return step.options.map((opt) => `<label class="choice-opt ${step.value === opt ? 'sel' : ''}">
      <input type="radio" name="${step.id}" value="${esc(opt)}" data-val="${step.id}" ${step.value === opt ? 'checked' : ''}>
      <span>${esc(opt)}</span></label>`).join('');
  }

  return '';
}

function render() {
  if (!JOB) return;

  if (JOB.status === 'submitted' || JOB.status === 'approved') return renderDone();

  const activeIndex = JOB.steps.findIndex((s) => !s.complete && !s.locked);
  const p = JOB.progress;
  const pendingCount = Object.values(pendingByStep).reduce((n, arr) => n + arr.length, 0);

  const header = `<div class="topbar">
    <div class="job">${esc(JOB.checklistName)}</div>
    <div class="sub">${esc(JOB.address || JOB.title)}${JOB.customer ? ` · ${esc(JOB.customer)}` : ''}</div>
    <div class="bar"><i style="width:${p.pct}%"></i></div>
    <div class="count">${p.done} of ${p.total} done · ${p.photoCount} photo${p.photoCount === 1 ? '' : 's'} saved</div>
  </div>`;

  const banners = [];
  if (JOB.status === 'rejected' && JOB.reviewNote) {
    banners.push(`<div class="banner banner--red">Sent back by the office: ${esc(JOB.reviewNote)}</div>`);
  }
  if (!navigator.onLine) {
    banners.push(`<div class="banner banner--amber">You're offline. Keep working — everything is saved on this phone and sends itself when you get signal.</div>`);
  }
  if (JOB.code?.fail) {
    const failing = JOB.steps.filter((s) => s.code?.state === 'fail');
    banners.push(`<div class="banner banner--red" data-jump="${failing[0]?.id || ''}" style="cursor:pointer">
      <b>${failing.map((s) => esc(s.label)).join(', ')}</b>
      ${failing.length > 1 ? 'do' : 'does'} not meet code${JOB.jurisdictionName ? ` for ${esc(JOB.jurisdictionName)}` : ''}.
      Fix it on site, or tell the office why you can't — nothing below it opens until then.
      <br><span style="text-decoration:underline">Take me to it</span></div>`);
  }
  if (JOB.siteNotes) {
    banners.push(`<div class="banner banner--blue">${esc(JOB.siteNotes)}</div>`);
  }
  if (JOB.gated && p.done === 0) {
    banners.push(`<div class="banner banner--blue">Steps unlock in order. Do them as you go — you can't come back and add the during-photos once the hole is filled in.</div>`);
  }

  const steps = JOB.steps.map((step, i) => {
    const cls = stepStatusClass(step, i, activeIndex);
    const optional = step.required === false;

    // A finished step folds down to one line so the step they're actually on
    // is the thing on screen, not thirty items of scrollback.
    const codeFail = step.code?.state === 'fail';
    if (step.complete && !codeFail && !reopened.has(step.id) && i !== activeIndex) {
      return `<section class="step done compact" data-expand="${step.id}">
        <div class="step-head" style="margin:0;align-items:center">
          <div class="step-num">✓</div>
          <div class="grow truncate"><span class="bold">${esc(step.label)}</span></div>
          <div class="tiny muted" style="flex:0 0 auto">${esc(stepSummary(step))}</div>
        </div>
      </section>`;
    }

    return `<section class="step ${cls}" data-step="${step.id}">
      <div class="step-head">
        <div class="step-num">${step.code?.state === 'fail' ? '!' : step.complete ? '✓' : i + 1}</div>
        <div class="grow">
          <div class="step-label">${esc(step.label)}</div>
          ${optional ? '<div class="tiny muted">Optional</div>' : ''}
          ${step.locked ? '<div class="tiny muted">Finish the steps above first</div>' : ''}
        </div>
      </div>
      ${!step.locked && step.help ? `<div class="step-help">${esc(step.help)}</div>` : ''}
      ${!step.locked ? codeBlock(step) : ''}
      ${!step.locked ? `<div class="step-body">${renderStepBody(step)}</div>` : ''}
    </section>`;
  }).join('');

  const codeFails = JOB.code?.fail || 0;
  const blocked = p.done < p.total || pendingCount > 0 || codeFails > 0;
  const footer = `<div class="footer"><div class="inner">
    ${pendingCount ? `<div class="small bold" style="margin-bottom:8px;color:var(--amber)">
      ${pendingCount} photo${pendingCount > 1 ? 's' : ''} still uploading — leave this page open.</div>` : ''}
    <button class="btn btn--lg btn--block ${blocked ? '' : 'btn--green'}" id="submit" ${blocked ? 'disabled' : ''}>
      ${pendingCount ? 'Waiting on photos…'
        : codeFails ? `${codeFails} code issue${codeFails > 1 ? 's' : ''} to clear`
        : blocked ? `${p.total - p.done} item${p.total - p.done === 1 ? '' : 's'} left`
        : 'Turn in this job'}
    </button>
  </div></div>`;

  $('#app').innerHTML = `${header}<div class="wrap" style="padding-top:16px">${banners.join('')}${steps}</div>${footer}`;
  wireUp();
}

function renderPendingBanner() {
  if (JOB && JOB.status !== 'submitted') refreshPending().then(render);
}

function renderDone() {
  const p = JOB.progress;
  $('#app').innerHTML = `
    <div class="topbar"><div class="job">${esc(JOB.checklistName)}</div>
      <div class="sub">${esc(JOB.address || JOB.title)}</div></div>
    <div class="wrap">
      <div class="done-screen">
        <div class="done-mark">✓</div>
        <h1>Turned in</h1>
        <p class="muted" style="margin-top:8px">
          ${p.total} item${p.total === 1 ? '' : 's'} completed · ${p.photoCount} photos sent to the office.<br>
          ${JOB.submittedAt ? esc(new Date(JOB.submittedAt).toLocaleString()) : ''}
        </p>
        <p class="muted small" style="margin-top:20px">Nothing else to do. The office has it.</p>
      </div>
    </div>`;
}

// ---------------------------------------------------------------- event wiring

function wireUp() {
  // tap a folded-up step to open it back up
  for (const el of document.querySelectorAll('[data-expand]')) {
    el.addEventListener('click', () => {
      reopened.add(el.dataset.expand);
      render();
      document.querySelector(`[data-step="${el.dataset.expand}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  $('[data-jump]')?.addEventListener('click', (e) => {
    const stepId = e.currentTarget.dataset.jump;
    if (!stepId) return;
    reopened.add(stepId);
    render();
    document.querySelector(`[data-step="${stepId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  // ask the office for a variance on a code step that cannot be met on site
  for (const btn of document.querySelectorAll('[data-variance]')) {
    btn.addEventListener('click', async () => {
      const reason = prompt(
        'What is stopping you from meeting this?\n\n'
        + 'Be specific — the office has to decide on it, and this goes on the record.');
      if (!reason || !reason.trim()) return;
      try {
        JOB = await apiCall(`/api/job/${TOKEN}/override`, {
          method: 'POST',
          body: JSON.stringify({ stepId: btn.dataset.variance, reason: reason.trim() }),
        });
        toast('Sent to the office', 'good');
        render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  }

  // photo capture
  for (const input of document.querySelectorAll('[data-shoot]')) {
    input.addEventListener('change', async (e) => {
      const stepId = e.target.dataset.shoot;
      const files = [...e.target.files];
      e.target.value = '';
      if (!files.length) return;
      toast(`Processing ${files.length} photo${files.length > 1 ? 's' : ''}…`);
      for (const file of files) {
        try {
          await capturePhoto(stepId, file);
        } catch (err) {
          toast(err.message || 'That photo did not work. Try again.', 'bad');
        }
      }
      await refreshPending();
      render();
    });
  }

  // delete an uploaded photo
  for (const btn of document.querySelectorAll('[data-del]')) {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this photo?')) return;
      try {
        JOB = await apiCall(`/api/job/${TOKEN}/photo/${btn.dataset.del}/delete`, { method: 'POST' });
        render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    });
  }

  // values: text/number save on blur, check/radio save immediately
  for (const el of document.querySelectorAll('[data-val]')) {
    const stepId = el.dataset.val;
    if (el.type === 'checkbox') {
      el.addEventListener('change', () => saveValue(stepId, el.checked));
    } else if (el.type === 'radio') {
      el.addEventListener('change', () => { if (el.checked) saveValue(stepId, el.value); });
    } else {
      el.addEventListener('blur', () => {
        const step = JOB.steps.find((s) => s.id === stepId);
        const current = step?.value ?? '';
        if (String(current) !== el.value) saveValue(stepId, el.value, { quiet: true });
      });
    }
  }

  wireSignature();

  const submit = $('#submit');
  if (submit) submit.addEventListener('click', doSubmit);
}

async function saveValue(stepId, value, { quiet = false } = {}) {
  try {
    JOB = await apiCall(`/api/job/${TOKEN}/entry`, {
      method: 'POST',
      body: JSON.stringify({ stepId, value }),
    });
    if (!quiet) toast('Saved', 'good');
    render();
  } catch (err) {
    toast(err.message, 'bad');
  }
}

// ----------------------------------------------------------------- signature

function wireSignature() {
  const pad = $('#sigpad');
  if (!pad) return;
  const ratio = window.devicePixelRatio || 1;
  pad.width = pad.offsetWidth * ratio;
  pad.height = pad.offsetHeight * ratio;
  const ctx = pad.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#12161c';

  let drawing = false;
  let dirty = false;
  const point = (e) => {
    const rect = pad.getBoundingClientRect();
    const t = e.touches ? e.touches[0] : e;
    return { x: t.clientX - rect.left, y: t.clientY - rect.top };
  };
  const start = (e) => { e.preventDefault(); drawing = true; dirty = true; const p = point(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); };
  const move = (e) => { if (!drawing) return; e.preventDefault(); const p = point(e); ctx.lineTo(p.x, p.y); ctx.stroke(); };
  const end = () => { drawing = false; };

  pad.addEventListener('pointerdown', start);
  pad.addEventListener('pointermove', move);
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointerleave', end);

  $('[data-sigclear]')?.addEventListener('click', () => {
    ctx.clearRect(0, 0, pad.width, pad.height);
    dirty = false;
  });

  $('[data-sigsave]')?.addEventListener('click', async (e) => {
    const stepId = e.target.dataset.sigsave;
    if (!dirty) return toast('Have them sign in the box first.', 'bad');
    const white = document.createElement('canvas');
    white.width = pad.width;
    white.height = pad.height;
    const wctx = white.getContext('2d');
    wctx.fillStyle = '#fff';
    wctx.fillRect(0, 0, white.width, white.height);
    wctx.drawImage(pad, 0, 0);
    const blob = await new Promise((r) => white.toBlob(r, 'image/jpeg', 0.85));
    const position = await getPosition();
    await queueAdd({
      localId: `sig-${Date.now()}`,
      token: TOKEN, stepId, blob,
      width: white.width, height: white.height,
      capturedAt: Date.now(), originalAt: Date.now(),
      lat: position?.lat ?? null, lng: position?.lng ?? null, accuracy: position?.accuracy ?? null,
    });
    toast('Signature saved', 'good');
    await refreshPending();
    render();
    pump();
  });
}

// -------------------------------------------------------------------- submit

async function doSubmit() {
  if (submitting) return;
  const pendingCount = Object.values(pendingByStep).reduce((n, arr) => n + arr.length, 0);
  if (pendingCount) return toast('Photos are still uploading. Hang on.', 'bad');

  submitting = true;
  const btn = $('#submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
  try {
    JOB = await apiCall(`/api/job/${TOKEN}/submit`, { method: 'POST' });
    render();
  } catch (err) {
    const codeFails = err.payload?.codeFailures || [];
    const missing = err.payload?.missing || [];
    if (codeFails.length || missing.length) {
      const parts = [];
      if (codeFails.length) {
        parts.push(`DOES NOT MEET CODE:\n${codeFails.map((c) =>
          `• ${c.label} — ${c.message}${c.citation ? `\n  (${c.citation})` : ''}`).join('\n')}`);
      }
      if (missing.length) {
        parts.push(`STILL TO DO:\n${missing.map((m) => `• ${m.label} (${m.reason})`).join('\n')}`);
      }
      alert(parts.join('\n\n'));
    } else {
      toast(err.message, 'bad');
    }
    render();
  } finally {
    submitting = false;
  }
}

// ---------------------------------------------------------------------- boot

async function refreshPending() {
  const rows = await queueAll();
  pendingByStep = {};
  for (const row of rows) (pendingByStep[row.stepId] ||= []).push(row);
}

async function boot() {
  try {
    JOB = await apiCall(`/api/job/${TOKEN}`);
  } catch (err) {
    document.body.innerHTML = `<div class="wrap" style="padding-top:60px;text-align:center">
      <h1>Link not valid</h1>
      <p class="muted" style="margin-top:12px">${esc(err.message)}</p>
      <p class="muted small">Check with the office for a new link.</p></div>`;
    return;
  }

  await refreshPending();
  render();

  if (JOB.status === 'assigned') {
    apiCall(`/api/job/${TOKEN}/start`, { method: 'POST' })
      .then((updated) => { JOB = updated; render(); })
      .catch(() => {});
    getPosition(); // prompt for location early, not mid-photo
  }

  pump();

  window.addEventListener('online', () => { toast('Back online — sending photos'); pump(); render(); });
  window.addEventListener('offline', render);

  // Don't let anyone walk away with photos still sitting in the queue.
  window.addEventListener('beforeunload', (e) => {
    const count = Object.values(pendingByStep).reduce((n, arr) => n + arr.length, 0);
    if (count > 0) { e.preventDefault(); e.returnValue = ''; }
  });

  setInterval(() => { if (navigator.onLine) pump(); }, 20000);
}

boot();
