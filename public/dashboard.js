/* Office view: assign a job, text the link, watch it come back. */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = null;
let tab = 'jobs';
let filter = 'open';

// iOS wants &body=, everything else wants ?body=. Built here because it depends
// on the phone the office is holding, not on the server.
const isApple = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent);
const dial = (phone) => String(phone || '').replace(/[^\d+]/g, '');
const smsHref = (phone, body) =>
  `sms:${dial(phone)}${isApple ? '&' : '?'}body=${encodeURIComponent(body)}`;

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ''; }, kind === 'bad' ? 5000 : 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
  });
  if (res.status === 401) { location.reload(); throw new Error('Signed out'); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Failed (${res.status})`);
  return body;
}

const ago = (ts) => {
  if (!ts) return '';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const when = (ts) => ts ? new Date(ts).toLocaleString([], {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';

// ------------------------------------------------------------------- sheets

function openSheet(html) {
  const sheet = $('#sheet');
  sheet.innerHTML = html;
  if (!sheet.open) sheet.showModal();
  sheet.querySelector('[data-close]')?.addEventListener('click', () => sheet.close());
  return sheet;
}
const closeSheet = () => $('#sheet').close();

// --------------------------------------------------------------- jobs tab

const STATUS_PILL = {
  assigned: 'pill',
  in_progress: 'pill pill--blue',
  submitted: 'pill pill--amber',
  approved: 'pill pill--green',
  rejected: 'pill pill--red',
};

function jobMatchesFilter(job) {
  if (filter === 'all') return true;
  if (filter === 'review') return job.status === 'submitted';
  if (filter === 'open') return job.status !== 'approved';
  if (filter === 'late') return job.overdue;
  if (filter === 'done') return job.status === 'approved';
  return true;
}

function jobsTab() {
  const jobs = STATE.jobs.filter(jobMatchesFilter);
  const counts = {
    review: STATE.jobs.filter((j) => j.status === 'submitted').length,
    late: STATE.jobs.filter((j) => j.overdue).length,
  };

  const chips = [
    ['open', 'Open'],
    ['review', `Needs review${counts.review ? ` (${counts.review})` : ''}`],
    ['late', `Nothing yet${counts.late ? ` (${counts.late})` : ''}`],
    ['done', 'Approved'],
    ['all', 'Everything'],
  ].map(([key, label]) =>
    `<button class="chip ${filter === key ? 'on' : ''}" data-filter="${key}">${label}</button>`).join('');

  const list = jobs.length ? jobs.map((job) => `
    <div class="jobcard" data-job="${job.id}">
      <div class="grow">
        <div class="row wrapflex" style="gap:8px">
          <span class="bold">${esc(job.checklistName)}</span>
          <span class="${STATUS_PILL[job.status]}">${esc(job.statusLabel)}</span>
          ${job.overdue ? '<span class="pill pill--red">No movement</span>' : ''}
          ${job.flagCount ? `<span class="pill pill--amber">${job.flagCount} flag${job.flagCount > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="who">${esc(job.assignedName)}${job.address ? ` · ${esc(job.address)}` : ''} · ${ago(job.lastActivityAt)}</div>
        <div class="bar"><i style="width:${job.progress.pct}%"></i></div>
      </div>
      <div style="text-align:right;flex:0 0 auto">
        <div class="bold">${job.progress.done}/${job.progress.total}</div>
        <div class="tiny muted">${job.progress.photoCount} photos</div>
      </div>
    </div>`).join('') : `<div class="empty">
      <p class="bold">Nothing here.</p><p class="small">Assign a job and text it out.</p></div>`;

  return `
    <div class="row-between wrapflex" style="margin-bottom:18px">
      <h1>Jobs</h1>
      <button class="btn" id="newjob">+ New job</button>
    </div>
    <div class="filters">${chips}</div>
    ${list}
    ${STATE.activity.length ? `<h2 style="margin:32px 0 12px">Recent activity</h2>
      <div class="card">${STATE.activity.slice(0, 14).map((a) => `
        <div class="row" style="padding:7px 0;border-bottom:1px solid var(--line-2);gap:10px">
          <span class="tiny muted" style="flex:0 0 68px">${ago(a.at)}</span>
          <span class="small grow">${esc(a.message)}</span>
        </div>`).join('')}</div>` : ''}`;
}

// -------------------------------------------------------------- new job flow

function newJobSheet() {
  const crewOptions = STATE.crew.map((c) =>
    `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  const tplOptions = STATE.templates.map((t) =>
    `<option value="${t.id}">${esc(t.name)} — ${t.photoCount} photos required</option>`).join('');

  openSheet(`
    <div class="sheet-head"><h2>New job</h2><button class="closex" data-close>&times;</button></div>
    <div class="sheet-body">
      <form id="jobform">
        <label class="field"><span>Checklist</span>
          <select name="templateId" required>${tplOptions}</select></label>
        <label class="field"><span>Who's doing it</span>
          <select name="crewId" id="crewsel">
            ${crewOptions}<option value="">— someone not on the list —</option>
          </select></label>
        <div id="oneoff" class="hide">
          <label class="field"><span>Name</span><input type="text" name="assignedName"></label>
          <label class="field"><span>Mobile number</span>
            <input type="tel" name="assignedPhone" placeholder="(555) 123-4567"></label>
        </div>
        <label class="field"><span>Job site address</span>
          <input type="text" name="address" placeholder="412 Hardy Rd"></label>
        <label class="field"><span>Customer <span class="muted">(optional)</span></span>
          <input type="text" name="customer"></label>
        <label class="field"><span>Due by <span class="muted">(optional)</span></span>
          <input type="datetime-local" name="dueAt"></label>
        <label class="field"><span>Note for the crew <span class="muted">(optional)</span></span>
          <textarea name="siteNotes" placeholder="Gate code, where to park, watch the septic field…"></textarea></label>
        <button class="btn btn--block btn--lg" type="submit">Create &amp; get the link</button>
      </form>
    </div>`);

  const sel = $('#crewsel');
  const toggle = () => $('#oneoff').classList.toggle('hide', !!sel.value);
  sel.addEventListener('change', toggle);
  if (!STATE.crew.length) { sel.value = ''; toggle(); }

  $('#jobform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const job = await api('/api/jobs', { method: 'POST', body: JSON.stringify(body) });
      await refresh();
      sendSheet(job);
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
    }
  });
}

/** The moment that matters: getting the link onto the guy's phone. */
function sendSheet(job) {
  openSheet(`
    <div class="sheet-head"><h2>Send it to ${esc(job.assignedName)}</h2>
      <button class="closex" data-close>&times;</button></div>
    <div class="sheet-body">
      <p class="muted">${esc(job.checklistName)}${job.address ? ` at ${esc(job.address)}` : ''}</p>
      ${STATE.config.twilioReady
        ? `<button class="btn btn--block btn--lg" id="autosend">Text it now</button>
           <p class="tiny muted" style="margin-top:10px;text-align:center">Sends from your company number.</p>`
        : `<a class="btn btn--block btn--lg" id="manualsend" href="#">Open Messages with it typed out</a>
           <p class="tiny muted" style="margin-top:10px;text-align:center">
             Opens your own texting app. Add Twilio keys in Setup to have the app send these for you.</p>`}
      <div class="card" style="margin-top:18px;background:var(--bg-2)">
        <div class="tiny bold muted" style="text-transform:uppercase;letter-spacing:.05em">The message</div>
        <pre class="small" style="white-space:pre-wrap;margin:8px 0 0;font-family:inherit">${esc(job.smsBody)}</pre>
      </div>
      <div class="row" style="margin-top:14px">
        <input type="text" value="${esc(job.link)}" readonly id="linkfield" class="grow">
        <button class="btn btn--ghost btn--sm" id="copylink">Copy</button>
      </div>
      <button class="btn btn--ghost btn--block" style="margin-top:18px" data-close>Done</button>
    </div>`);

  const manual = $('#manualsend');
  if (manual) manual.href = smsHref(job.assignedPhone, job.smsBody);

  $('#autosend')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Sending…';
    try {
      const result = await api(`/api/jobs/${job.id}/send`, { method: 'POST' });
      if (result.sent) { toast('Texted', 'good'); closeSheet(); refresh(); }
      else { toast(result.reason || 'Could not send', 'bad'); e.target.disabled = false; e.target.textContent = 'Text it now'; }
    } catch (err) {
      toast(err.message, 'bad');
      e.target.disabled = false;
    }
  });

  $('#copylink')?.addEventListener('click', async () => {
    const field = $('#linkfield');
    try {
      await navigator.clipboard.writeText(field.value);
      toast('Link copied', 'good');
    } catch {
      field.select();
      toast('Press copy on your keyboard');
    }
  });
}

// ------------------------------------------------------------- job detail

async function openJob(jobId) {
  let job;
  try { job = await api(`/api/jobs/${jobId}`); }
  catch (err) { return toast(err.message, 'bad'); }

  const flags = job.flags.map((f) =>
    `<div class="flag flag--${f.level}">${esc(f.text)}</div>`).join('');

  const steps = job.steps.map((s) => {
    let answer = '';
    if (s.type === 'check') answer = s.value === true ? '✓ Confirmed' : '<span class="muted">—</span>';
    else if (s.value !== null && s.value !== '') answer = esc(s.value);

    const shots = s.photos.length ? `<div class="shots" style="margin-top:9px">${s.photos.map((p) => `
      <div class="shot"><a href="/media/${p.photoId}" target="_blank" rel="noopener">
        <img src="/media/${p.photoId}" alt="" loading="lazy"></a>
        <div class="stamp">${new Date(p.capturedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}${p.lat ? ' · GPS' : ''}</div>
      </div>`).join('')}</div>` : '';

    return `<div class="dstep">
      <div class="row-between" style="gap:10px;align-items:flex-start">
        <span class="bold grow">${esc(s.label)}</span>
        <span class="${s.complete ? 'pill pill--green' : 'pill pill--red'}">${s.complete ? 'Done' : s.required === false ? 'Skipped' : 'Missing'}</span>
      </div>
      ${answer ? `<div style="margin-top:5px">${answer}</div>` : ''}
      ${shots}
    </div>`;
  }).join('');

  const canReview = job.status === 'submitted' || job.status === 'approved';

  openSheet(`
    <div class="sheet-head">
      <div><h2>${esc(job.checklistName)}</h2>
        <div class="small muted" style="margin-top:3px">
          ${esc(job.assignedName)}${job.address ? ` · ${esc(job.address)}` : ''}</div></div>
      <button class="closex" data-close>&times;</button>
    </div>
    <div class="sheet-body">
      <div class="row wrapflex" style="margin-bottom:14px">
        <span class="${STATUS_PILL[job.status]}">${esc(job.statusLabel)}</span>
        <span class="pill">${job.progress.done}/${job.progress.total} steps</span>
        <span class="pill">${job.progress.photoCount} photos</span>
      </div>
      ${flags}
      ${job.missing.length ? `<div class="flag flag--warn"><b>Still outstanding:</b><br>
        ${job.missing.map((m) => `${esc(m.label)} — ${esc(m.reason)}`).join('<br>')}</div>` : ''}

      <div class="row wrapflex" style="margin:14px 0">
        <button class="btn btn--ghost btn--sm" id="resend">Send link again</button>
        ${job.status !== 'submitted' && job.status !== 'approved'
          ? `<button class="btn btn--ghost btn--sm" id="remind">Nudge ${esc(job.assignedName.split(' ')[0])}</button>` : ''}
        <a class="btn btn--ghost btn--sm" href="${job.report}" target="_blank" rel="noopener">Customer report</a>
      </div>

      ${canReview ? `<div class="card" style="background:var(--bg-2);margin-bottom:16px">
        <div class="bold" style="margin-bottom:9px">Review</div>
        ${job.status === 'approved'
          ? `<p class="small muted" style="margin:0">Approved ${when(job.reviewedAt)}.</p>`
          : `<textarea id="reviewnote" placeholder="What needs fixing? (required to send back)" style="min-height:70px"></textarea>
             <div class="row" style="margin-top:9px">
               <button class="btn btn--green grow" data-review="approve">Approve</button>
               <button class="btn btn--red grow" data-review="reject">Send back</button>
             </div>`}
      </div>` : ''}

      <div class="small muted" style="margin-bottom:6px">
        Created ${when(job.createdAt)} · Started ${when(job.startedAt)} · Turned in ${when(job.submittedAt)}
      </div>
      ${steps}
      <button class="btn btn--ghost btn--block" style="margin-top:20px;color:var(--red)" id="delete">Delete this job</button>
    </div>`);

  $('#resend')?.addEventListener('click', async () => {
    const result = await api(`/api/jobs/${job.id}/send`, { method: 'POST' });
    if (result.sent) return toast('Texted', 'good');
    location.href = smsHref(dial(result.phone), result.body);
  });

  $('#remind')?.addEventListener('click', async () => {
    const result = await api(`/api/jobs/${job.id}/remind`, { method: 'POST' });
    if (result.sent) return toast('Reminder sent', 'good');
    location.href = smsHref(dial(result.phone), result.body);
  });

  for (const btn of document.querySelectorAll('[data-review]')) {
    btn.addEventListener('click', async () => {
      const decision = btn.dataset.review;
      const note = $('#reviewnote')?.value || '';
      if (decision === 'reject' && !note.trim()) return toast('Say what needs fixing.', 'bad');
      try {
        await api(`/api/jobs/${job.id}/review`, {
          method: 'POST', body: JSON.stringify({ decision, note }),
        });
        toast(decision === 'approve' ? 'Approved' : 'Sent back', 'good');
        closeSheet();
        refresh();
      } catch (err) { toast(err.message, 'bad'); }
    });
  }

  $('#delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this job and every photo on it? This cannot be undone.')) return;
    await api(`/api/jobs/${job.id}/delete`, { method: 'POST' });
    closeSheet();
    refresh();
    toast('Deleted');
  });
}

// ------------------------------------------------------------ checklists tab

function checklistsTab() {
  return `
    <div class="row-between wrapflex" style="margin-bottom:8px">
      <h1>Checklists</h1>
      <button class="btn" data-edittpl="new">+ New checklist</button>
    </div>
    <p class="muted small" style="margin-bottom:18px">
      These are the lists your crew works down. Anything marked required has to be filled in
      before the job can be turned in.</p>
    ${STATE.templates.map((t) => `
      <div class="card" style="margin-bottom:10px">
        <div class="row-between wrapflex">
          <div class="grow">
            <div class="bold">${esc(t.name)}</div>
            <div class="small muted">${esc(t.description || '')}</div>
            <div class="row wrapflex" style="margin-top:8px;gap:6px">
              <span class="pill">${t.stepCount} steps</span>
              <span class="pill pill--blue">${t.photoCount} photos required</span>
              ${t.gated ? '<span class="pill pill--amber">In order</span>' : ''}
            </div>
          </div>
          <button class="btn btn--ghost btn--sm" data-edittpl="${t.id}">Edit</button>
        </div>
      </div>`).join('')}`;
}

const TYPE_LABEL = {
  photo: 'Photos', text: 'Text', number: 'Number',
  check: 'Checkbox', choice: 'Pick one', signature: 'Signature',
};

async function editTemplate(tplId) {
  let tpl = { name: '', trade: '', description: '', gated: false, steps: [] };
  if (tplId !== 'new') {
    try { tpl = await api(`/api/templates/${tplId}`); }
    catch (err) { return toast(err.message, 'bad'); }
  }
  let steps = structuredClone(tpl.steps);

  const drawSteps = () => steps.map((s, i) => `
    <div class="steprow">
      <div class="grip" data-move="${i}">⠿</div>
      <div class="grow">
        <input type="text" value="${esc(s.label)}" data-slabel="${i}" placeholder="What do they have to do?">
        <div class="row wrapflex" style="margin-top:7px;gap:7px">
          <select data-stype="${i}" style="flex:0 0 auto;width:auto;min-height:40px;font-size:14px">
            ${Object.entries(TYPE_LABEL).map(([v, l]) =>
              `<option value="${v}" ${s.type === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
          ${s.type === 'photo' ? `<label class="tiny row" style="gap:5px">min
            <input type="number" min="1" max="20" value="${s.min || 1}" data-smin="${i}"
                   style="width:62px;min-height:40px;font-size:14px"></label>` : ''}
          ${s.type === 'choice' ? `<input type="text" data-sopts="${i}" value="${esc((s.options || []).join(', '))}"
                   placeholder="Option A, Option B" style="flex:1;min-height:40px;font-size:14px">` : ''}
          <label class="tiny row" style="gap:5px">
            <input type="checkbox" data-sreq="${i}" ${s.required !== false ? 'checked' : ''}
                   style="width:18px;height:18px">required</label>
          <button class="btn btn--ghost btn--sm" data-sdel="${i}" style="min-height:40px">Remove</button>
        </div>
        <input type="text" value="${esc(s.help || '')}" data-shelp="${i}"
               placeholder="Instructions for the crew (optional)"
               style="margin-top:7px;min-height:40px;font-size:14px">
      </div>
    </div>`).join('');

  const paint = () => {
    $('#steplist').innerHTML = drawSteps();
    wireSteps();
  };

  function wireSteps() {
    const bind = (attr, event, apply) => {
      for (const el of document.querySelectorAll(`[data-${attr}]`)) {
        el.addEventListener(event, () => {
          apply(steps[Number(el.dataset[attr])], el);
          if (event === 'change' && (attr === 'stype')) paint();
        });
      }
    };
    bind('slabel', 'input', (s, el) => { s.label = el.value; });
    bind('shelp', 'input', (s, el) => { s.help = el.value; });
    bind('smin', 'input', (s, el) => { s.min = Number(el.value) || 1; });
    bind('sreq', 'change', (s, el) => { s.required = el.checked; });
    bind('sopts', 'input', (s, el) => { s.options = el.value.split(',').map((o) => o.trim()).filter(Boolean); });
    bind('stype', 'change', (s, el) => {
      s.type = el.value;
      if (s.type === 'photo' && !s.min) s.min = 1;
      if (s.type === 'choice' && !s.options) s.options = ['Yes', 'No'];
    });
    for (const el of document.querySelectorAll('[data-sdel]')) {
      el.addEventListener('click', () => { steps.splice(Number(el.dataset.sdel), 1); paint(); });
    }
    for (const el of document.querySelectorAll('[data-move]')) {
      el.addEventListener('click', () => {
        const i = Number(el.dataset.move);
        if (i === 0) return;
        [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]];
        paint();
      });
    }
  }

  openSheet(`
    <div class="sheet-head"><h2>${tplId === 'new' ? 'New checklist' : 'Edit checklist'}</h2>
      <button class="closex" data-close>&times;</button></div>
    <div class="sheet-body">
      <label class="field"><span>Name</span>
        <input type="text" id="tname" value="${esc(tpl.name)}" placeholder="Water Line Installation"></label>
      <label class="field"><span>What it's for</span>
        <input type="text" id="tdesc" value="${esc(tpl.description || '')}"></label>
      <label class="checkbox ${tpl.gated ? 'sel' : ''}" style="margin-bottom:18px">
        <input type="checkbox" id="tgated" ${tpl.gated ? 'checked' : ''}>
        <span>Lock the steps in order — they can't skip ahead</span></label>
      <div class="row-between" style="margin-bottom:10px">
        <h3>Steps</h3><button class="btn btn--ghost btn--sm" id="addstep">+ Add step</button>
      </div>
      <div id="steplist"></div>
      <p class="tiny muted">⠿ moves a step up one place.</p>
      <div class="row" style="margin-top:20px">
        <button class="btn grow" id="savetpl">Save checklist</button>
        ${tplId !== 'new' ? '<button class="btn btn--ghost" id="archtpl">Archive</button>' : ''}
      </div>
    </div>`);

  paint();

  $('#addstep').addEventListener('click', () => {
    steps.push({ id: `step_${Date.now().toString(36)}`, type: 'photo', label: '', required: true, min: 1, help: '' });
    paint();
    $('#steplist').lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('#savetpl').addEventListener('click', async () => {
    try {
      const body = {
        name: $('#tname').value,
        description: $('#tdesc').value,
        gated: $('#tgated').checked,
        steps,
      };
      await api(tplId === 'new' ? '/api/templates' : `/api/templates/${tplId}`, {
        method: 'POST', body: JSON.stringify(body),
      });
      toast('Saved', 'good');
      closeSheet();
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('#archtpl')?.addEventListener('click', async () => {
    if (!confirm('Archive this checklist? Jobs already sent out keep working.')) return;
    await api(`/api/templates/${tplId}/archive`, { method: 'POST' });
    closeSheet();
    refresh();
  });
}

// -------------------------------------------------------------- crew tab

function crewTab() {
  return `
    <h1>Crew</h1>
    <p class="muted small" style="margin:8px 0 18px">
      Save the guys you send jobs to. They never sign in — they just open the link.</p>
    ${STATE.crew.map((c) => `
      <div class="card row-between" style="margin-bottom:9px">
        <div><div class="bold">${esc(c.name)}</div>
          <div class="small muted">${esc(c.phone)}</div></div>
        <button class="btn btn--ghost btn--sm" data-rmcrew="${c.id}">Remove</button>
      </div>`).join('') || '<p class="muted">Nobody saved yet.</p>'}
    <div class="card" style="margin-top:18px">
      <h3 style="margin-bottom:12px">Add someone</h3>
      <form id="crewform">
        <label class="field"><span>Name</span><input type="text" name="name" required></label>
        <label class="field"><span>Mobile number</span>
          <input type="tel" name="phone" placeholder="(555) 123-4567" required></label>
        <button class="btn btn--block" type="submit">Add</button>
      </form>
    </div>`;
}

// ------------------------------------------------------------- setup tab

function setupTab() {
  const c = STATE.config;
  const s = STATE.settings;
  const box = (ok, title, detail) => `<div class="sbox">
    <span class="pill ${ok ? 'pill--green' : 'pill--amber'}">${ok ? 'Ready' : 'Not set'}</span>
    <b style="margin-top:7px">${title}</b>
    <div class="tiny muted">${detail}</div></div>`;

  return `
    <h1>Setup</h1>
    <div class="setup-status" style="margin-top:18px">
      ${box(c.twilioReady, 'Automatic texting', c.twilioReady
        ? 'The app texts links and reminders itself.'
        : 'Links open in your own messaging app instead.')}
      ${box(c.ownerPhoneSet, 'Text me when a job lands', c.ownerPhoneSet
        ? 'You get a text on every completed job.'
        : 'Set OWNER_PHONE, or fill in the number below.')}
      ${box(c.webhookSet, 'Forward to Zapier / anywhere', c.webhookSet
        ? 'Every event is posted to your webhook.'
        : 'Optional. Sends job events anywhere you like.')}
    </div>
    <div class="card">
      <form id="setupform">
        <label class="field"><span>Company name (shows on texts and reports)</span>
          <input type="text" name="companyName" value="${esc(s.companyName)}"></label>
        <label class="field"><span>Your mobile — where job alerts go</span>
          <input type="tel" name="ownerPhone" value="${esc(s.ownerPhone || '')}" placeholder="(555) 987-6543"></label>
        <label class="field"><span>Nudge me if a job sits untouched for</span>
          <input type="number" name="reminderHours" min="1" max="72" value="${s.reminderHours}"></label>
        <label class="field"><span>Webhook URL (optional)</span>
          <input type="url" name="notifyWebhook" value="${esc(s.notifyWebhook || '')}"
                 placeholder="https://hooks.zapier.com/..."></label>
        <button class="btn btn--block" type="submit">Save</button>
      </form>
    </div>
    <div class="card" style="margin-top:14px;background:var(--bg-2)">
      <h3>Public address</h3>
      <p class="small muted" style="margin:6px 0 0">
        Links are built from <b>${esc(c.publicUrl)}</b>. If that isn't the address your crew can
        reach from their phones, set <code>PUBLIC_URL</code> and restart — otherwise the links you
        text will not open.</p>
    </div>`;
}

// --------------------------------------------------------------- shell

function render() {
  $('#brand').textContent = `${STATE.settings.companyName} · Job Board`;
  const views = { jobs: jobsTab, checklists: checklistsTab, crew: crewTab, setup: setupTab };
  $('#view').innerHTML = views[tab]();
  wireView();
}

function wireView() {
  for (const el of document.querySelectorAll('[data-filter]')) {
    el.addEventListener('click', () => { filter = el.dataset.filter; render(); });
  }
  for (const el of document.querySelectorAll('[data-job]')) {
    el.addEventListener('click', () => openJob(el.dataset.job));
  }
  for (const el of document.querySelectorAll('[data-edittpl]')) {
    el.addEventListener('click', () => editTemplate(el.dataset.edittpl));
  }
  for (const el of document.querySelectorAll('[data-rmcrew]')) {
    el.addEventListener('click', async () => {
      if (!confirm('Remove from the list?')) return;
      await api(`/api/crew/${el.dataset.rmcrew}/archive`, { method: 'POST' });
      refresh();
    });
  }
  $('#newjob')?.addEventListener('click', newJobSheet);

  $('#crewform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/crew', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      toast('Added', 'good');
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('#setupform')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'POST',
        body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      toast('Saved', 'good');
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  });
}

async function refresh() {
  STATE = await api('/api/state');
  render();
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => {
    tab = btn.dataset.tab;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t === btn);
    render();
  });
}

$('#signout').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  location.reload();
});

refresh();
setInterval(() => { if (!$('#sheet').open && document.visibilityState === 'visible') refresh(); }, 30000);
