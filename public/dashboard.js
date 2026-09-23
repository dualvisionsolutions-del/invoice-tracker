/* Office view: assign a job, text the link, watch it come back. */

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let STATE = null;
let tab = 'jobs';
let filter = 'open';
let openJurisdiction = null;

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
          ${job.codeFails ? `<span class="pill pill--red">${job.codeFails} code fail${job.codeFails > 1 ? 's' : ''}</span>` : ''}
          ${job.overridesPending ? '<span class="pill pill--amber">Variance requested</span>' : ''}
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

  const jurs = STATE.jurisdictions || [];
  const jurOptions = jurs.map((j) =>
    `<option value="${j.id}">${esc(j.name)}${j.enforcingCount ? ` — ${j.enforcingCount} code rule${j.enforcingCount > 1 ? 's' : ''}` : ' — no confirmed rules'}</option>`).join('');

  openSheet(`
    <div class="sheet-head"><h2>New job</h2><button class="closex" data-close>&times;</button></div>
    <div class="sheet-body">
      <form id="jobform">
        <label class="field"><span>Checklist</span>
          <select name="templateId" required>${tplOptions}</select></label>
        ${jurs.length ? `<label class="field"><span>Where the job is (sets which code rules apply)</span>
          <select name="jurisdictionId">
            ${jurOptions}<option value="">— no code rules on this one —</option>
          </select></label>` : ''}
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
      ${job.overrideRequests.length ? job.overrideRequests.map((o) => `
        <div class="card" style="border-color:var(--amber);background:var(--amber-bg);margin-bottom:12px">
          <div class="bold" style="color:var(--amber)">Variance requested — ${esc(o.label)}</div>
          <p class="small" style="margin:6px 0 0">"${esc(o.reason)}" — ${esc(o.requestedBy)}</p>
          <textarea id="ovnote-${o.stepId}" placeholder="Your decision and the reason for it"
                    style="min-height:60px;margin-top:9px"></textarea>
          <div class="row" style="margin-top:8px">
            <button class="btn btn--green grow btn--sm" data-ov="grant" data-step="${o.stepId}">Approve variance</button>
            <button class="btn btn--red grow btn--sm" data-ov="deny" data-step="${o.stepId}">Deny — make them fix it</button>
          </div>
        </div>`).join('') : ''}

      ${(() => {
        const settled = job.codeFindings.filter((f) => f.state !== 'unverified');
        const unconfirmed = job.codeFindings.length - settled.length;
        if (!settled.length && !unconfirmed) return '';
        return `<div class="card" style="margin-bottom:12px">
        <div class="row-between" style="margin-bottom:6px">
          <span class="bold">Code compliance${job.jurisdictionName ? ` — ${esc(job.jurisdictionName)}` : ''}</span>
          <span class="row" style="gap:5px">
            ${job.code.pass ? `<span class="pill pill--green">${job.code.pass} met</span>` : ''}
            ${job.code.fail ? `<span class="pill pill--red">${job.code.fail} failing</span>` : ''}
            ${job.code.waived ? `<span class="pill pill--amber">${job.code.waived} waived</span>` : ''}
            ${job.code.pending ? `<span class="pill">${job.code.pending} pending</span>` : ''}
          </span>
        </div>
        ${settled.map((f) => `
          <div class="findrow">
            <span class="pill ${f.state === 'pass' ? 'pill--green' : f.state === 'fail' ? 'pill--red' : 'pill--amber'}"
                  style="flex:0 0 auto">${f.state}</span>
            <div class="grow">
              <div class="bold">${esc(f.label)}</div>
              <div class="small muted">${esc(f.message)}</div>
              ${f.rule.citation ? `<div class="tiny muted">${esc(f.rule.citation)}</div>` : ''}
            </div>
          </div>`).join('')}
        ${!settled.length ? '<p class="small muted" style="margin:0">No confirmed rules applied to this job yet.</p>' : ''}
        ${unconfirmed ? `<p class="tiny muted" style="margin:10px 0 0">
          ${unconfirmed} more rule${unconfirmed > 1 ? 's are' : ' is'} attached but not confirmed, so
          ${unconfirmed > 1 ? 'they were' : 'it was'} not enforced here. Confirm ${unconfirmed > 1 ? 'them' : 'it'}
          under <b>Code rules</b>.</p>` : ''}
      </div>`;
      })()}

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

  for (const btn of document.querySelectorAll('[data-ov]')) {
    btn.addEventListener('click', async () => {
      const stepId = btn.dataset.step;
      const note = $(`#ovnote-${stepId}`)?.value || '';
      if (btn.dataset.ov === 'grant' && !note.trim()) {
        return toast('Record why the variance is acceptable — it goes on the report.', 'bad');
      }
      try {
        await api(`/api/jobs/${job.id}/override`, {
          method: 'POST',
          body: JSON.stringify({ stepId, decision: btn.dataset.ov, note }),
        });
        toast(btn.dataset.ov === 'grant' ? 'Variance approved' : 'Denied', 'good');
        closeSheet();
        refresh();
      } catch (err) { toast(err.message, 'bad'); }
    });
  }

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


// -------------------------------------------------------------- code tab

const CHECK_LABEL = {
  min: 'At least a set value',
  max: 'No more than a set value',
  range: 'Between two values',
  confirm: 'Confirmed on site (yes/no)',
  photo: 'Photographed',
};

function codeTab() {
  const jurs = STATE.jurisdictions || [];
  const rules = STATE.codeRules || [];
  const unconfirmed = rules.filter((r) => !r.enforceable).length;

  const intro = `<div class="warnbox">
    <b>Nothing here enforces until you confirm it.</b>
    <p class="small" style="margin:8px 0 0">
      These rules ship blank on purpose. Plumbing code is whatever edition your state adopted
      plus whatever your county and city amended — that is not something this app can guess, and
      a wrong number here would be worse than no number at all.</p>
    <p class="small" style="margin:8px 0 0">
      Fill in the value from your adopted code, paste the citation, and put your name on it. Until
      then the rule is invisible to your crew and blocks nothing. Each rule tells you where to look.</p>
  </div>`;

  if (openJurisdiction) {
    const jur = jurs.find((j) => j.id === openJurisdiction);
    if (!jur) { openJurisdiction = null; return codeTab(); }
    const mine = rules.filter((r) => r.jurisdictionId === jur.id);
    const tplName = (id) => STATE.templates.find((t) => t.id === id)?.name || id;

    return `
      <button class="btn btn--ghost btn--sm" data-backjur="1" style="margin-bottom:14px">&larr; All jurisdictions</button>
      <div class="row-between wrapflex" style="margin-bottom:6px">
        <h1>${esc(jur.name)}</h1>
        <div class="row">
          <button class="btn btn--ghost btn--sm" data-editjur="${jur.id}">Edit</button>
          <button class="btn btn--sm" data-newrule="${jur.id}">+ Rule</button>
        </div>
      </div>
      <p class="muted small" style="margin-bottom:16px">
        ${jur.codeBase ? `Adopted code: <b>${esc(jur.codeBase)}</b> · ` : ''}
        ${jur.enforcingCount} of ${jur.ruleCount} rules confirmed and enforcing</p>
      ${!mine.length ? `<div class="card" style="text-align:center">
        <p class="bold">No rules here yet.</p>
        <p class="small muted">Start from the common subjects for underground work — they come in blank.</p>
        <button class="btn" data-starter="${jur.id}">Load the starter subjects</button></div>` : ''}
      ${mine.map((r) => `
        <div class="rulecard ${r.enforceable ? 'enforcing' : 'pending'}">
          <div class="row-between wrapflex" style="align-items:flex-start;gap:8px">
            <div class="grow">
              <div class="bold">${esc(r.title)}</div>
              <div class="small" style="margin-top:3px">
                ${r.requirementText
                  ? `<b>${esc(r.requirementText)}</b>`
                  : '<span style="color:var(--amber);font-weight:700">No value filled in yet</span>'}
                ${r.citation ? ` · <span class="muted">${esc(r.citation)}</span>` : ''}
              </div>
              <div class="row wrapflex" style="gap:6px;margin-top:8px">
                ${r.enforceable
                  ? `<span class="pill pill--green">Enforcing</span>
                     <span class="pill">Confirmed by ${esc(r.verifiedBy)}</span>`
                  : '<span class="pill pill--amber">Not confirmed — blocks nothing</span>'}
                ${r.blocking ? '' : '<span class="pill">Advisory only</span>'}
                ${(r.appliesTo || []).map((t) => `<span class="pill pill--blue">${esc(tplName(t))}</span>`).join('')}
              </div>
              ${!r.enforceable && r.lookupHint
                ? `<div class="hint"><b>Where to find this:</b> ${esc(r.lookupHint)}</div>` : ''}
            </div>
            <div class="row" style="flex:0 0 auto">
              <button class="btn btn--ghost btn--sm" data-editrule="${r.id}">Edit</button>
              <button class="btn btn--sm ${r.enforceable ? 'btn--ghost' : ''}" data-verify="${r.id}">
                ${r.enforceable ? 'Unconfirm' : 'Confirm'}</button>
            </div>
          </div>
        </div>`).join('')}`;
  }

  return `
    <div class="row-between wrapflex" style="margin-bottom:14px">
      <h1>Code rules</h1>
      <button class="btn" id="newjur">+ Jurisdiction</button>
    </div>
    ${intro}
    ${unconfirmed ? `<p class="small" style="color:var(--amber);font-weight:700;margin-bottom:12px">
      ${unconfirmed} rule${unconfirmed > 1 ? 's are' : ' is'} still waiting on a value and a sign-off.</p>` : ''}
    ${jurs.length ? jurs.map((j) => `
      <div class="card row-between wrapflex" style="margin-bottom:10px;cursor:pointer" data-openjur="${j.id}">
        <div>
          <div class="bold">${esc(j.name)}</div>
          <div class="small muted">${esc(j.codeBase || 'Adopted code not recorded')}</div>
        </div>
        <div class="row">
          ${j.enforcingCount ? `<span class="pill pill--green">${j.enforcingCount} enforcing</span>` : ''}
          ${j.ruleCount - j.enforcingCount
            ? `<span class="pill pill--amber">${j.ruleCount - j.enforcingCount} to confirm</span>` : ''}
          ${!j.ruleCount ? '<span class="pill">No rules yet</span>' : ''}
        </div>
      </div>`).join('') : `<div class="empty">
        <p class="bold">No jurisdictions yet.</p>
        <p class="small">Add the county or city you work in, then fill in its rules.</p></div>`}`;
}

function jurisdictionSheet(jid) {
  const jur = jid ? (STATE.jurisdictions || []).find((j) => j.id === jid) : null;
  openSheet(`
    <div class="sheet-head"><h2>${jur ? 'Edit jurisdiction' : 'New jurisdiction'}</h2>
      <button class="closex" data-close>&times;</button></div>
    <div class="sheet-body">
      <form id="jurform">
        <label class="field"><span>State</span>
          <input type="text" name="state" maxlength="2" value="${esc(jur?.state || '')}" placeholder="IA" required></label>
        <label class="field"><span>County <span class="muted">(leave blank for a state-wide rule set)</span></span>
          <input type="text" name="county" value="${esc(jur?.county || '')}" placeholder="Polk"></label>
        <label class="field"><span>City <span class="muted">(only if the city amends the county)</span></span>
          <input type="text" name="city" value="${esc(jur?.city || '')}"></label>
        <label class="field"><span>Which code did they adopt?</span>
          <input type="text" name="codeBase" value="${esc(jur?.codeBase || '')}"
                 placeholder="e.g. 2021 IPC with local amendments"></label>
        <label class="field"><span>Notes</span>
          <textarea name="notes" placeholder="Inspector name, how much notice they need, who to call…">${esc(jur?.notes || '')}</textarea></label>
        <button class="btn btn--block" type="submit">Save</button>
        ${jur ? '<button class="btn btn--ghost btn--block" style="margin-top:10px;color:var(--red)" id="rmjur">Remove this jurisdiction</button>' : ''}
      </form>
      <p class="tiny muted" style="margin-top:14px">
        State-wide rules apply to every county you add in that state, and a county's rules apply to
        its cities. Put a rule at the level it actually lives.</p>
    </div>`);

  $('#jurform').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = Object.fromEntries(new FormData(e.target));
      const saved = await api(jur ? `/api/jurisdictions/${jur.id}` : '/api/jurisdictions',
        { method: 'POST', body: JSON.stringify(body) });
      closeSheet();
      await refresh();
      openJurisdiction = saved.id;
      render();
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('#rmjur')?.addEventListener('click', async () => {
    if (!confirm('Remove this jurisdiction and all its rules? Jobs already sent out keep the rules they were assigned under.')) return;
    await api(`/api/jurisdictions/${jur.id}/archive`, { method: 'POST' });
    openJurisdiction = null;
    closeSheet();
    refresh();
  });
}

function ruleSheet(ruleId, jurisdictionId) {
  const rule = ruleId ? (STATE.codeRules || []).find((r) => r.id === ruleId) : null;
  const jid = rule?.jurisdictionId || jurisdictionId;
  const kind = rule?.check?.kind || 'min';

  openSheet(`
    <div class="sheet-head"><h2>${rule ? 'Edit rule' : 'New rule'}</h2>
      <button class="closex" data-close>&times;</button></div>
    <div class="sheet-body">
      ${rule?.lookupHint ? `<div class="hint" style="margin-bottom:16px"><b>Where to find this:</b> ${esc(rule.lookupHint)}</div>` : ''}
      <form id="ruleform">
        <label class="field"><span>What the rule is about</span>
          <input type="text" name="title" value="${esc(rule?.title || '')}"
                 placeholder="Minimum cover over water service" required></label>

        <label class="field"><span>How it is checked</span>
          <select name="kind" id="rulekind">
            ${Object.entries(CHECK_LABEL).map(([v, l]) =>
              `<option value="${v}" ${kind === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>

        <div id="valuefields"></div>

        <label class="field"><span>Citation <span class="muted">(what you are relying on)</span></span>
          <input type="text" name="citation" value="${esc(rule?.citation || '')}"
                 placeholder="e.g. 2021 IPC §603.2 as amended by Polk County"></label>
        <label class="field"><span>Link to the source</span>
          <input type="url" name="sourceUrl" value="${esc(rule?.sourceUrl || '')}"></label>
        <label class="field"><span>How to say it to the crew</span>
          <textarea name="plainLanguage" placeholder="Plain words your guys will actually read on site">${esc(rule?.plainLanguage || '')}</textarea></label>

        <div class="field"><span class="bold small">Applies to which checklists</span>
          <div style="margin-top:6px">
            ${STATE.templates.map((t) => `<label class="tiny row" style="gap:7px;padding:5px 0">
              <input type="checkbox" name="appliesTo" value="${t.id}" style="width:18px;height:18px"
                ${(rule?.appliesTo || []).includes(t.id) ? 'checked' : ''}>${esc(t.name)}</label>`).join('')}
          </div>
          <p class="tiny muted" style="margin-top:4px">Tick none and it applies to every checklist.</p>
        </div>

        <label class="checkbox ${rule?.blocking !== false ? 'sel' : ''}" style="margin-bottom:16px">
          <input type="checkbox" name="blocking" ${rule?.blocking !== false ? 'checked' : ''}>
          <span>Stop the job when this is not met</span></label>

        <button class="btn btn--block" type="submit">Save rule</button>
        ${rule ? '<button class="btn btn--ghost btn--block" style="margin-top:10px;color:var(--red)" id="rmrule">Delete rule</button>' : ''}
      </form>
      ${rule?.verified ? `<p class="tiny muted" style="margin-top:14px">
        Changing the value or the citation clears the sign-off — somebody has to confirm it again
        before it starts enforcing.</p>` : ''}
    </div>`);

  const paintValues = () => {
    const k = $('#rulekind').value;
    const c = rule?.check || {};
    const unit = `<label class="field"><span>Unit</span>
      <input type="text" name="unit" value="${esc(c.unit || '')}" placeholder="inches, psi, minutes"></label>`;
    const num = (n, label) => `<label class="field"><span>${label}</span>
      <input type="number" step="any" name="${n}" value="${c[n] ?? ''}" placeholder="from your adopted code"></label>`;
    $('#valuefields').innerHTML =
      k === 'min' ? unit + num('min', 'Minimum allowed')
      : k === 'max' ? unit + num('max', 'Maximum allowed')
      : k === 'range' ? unit + num('min', 'Low end') + num('max', 'High end')
      : k === 'photo' ? `<label class="field"><span>Photos required</span>
          <input type="number" name="photoMin" min="1" max="10" value="${c.photoMin || 1}"></label>`
      : '<p class="small muted">Nothing to fill in — the crew ticks it on site.</p>';
  };
  $('#rulekind').addEventListener('change', paintValues);
  paintValues();

  $('#ruleform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      jurisdictionId: jid,
      title: fd.get('title'),
      citation: fd.get('citation'),
      sourceUrl: fd.get('sourceUrl'),
      plainLanguage: fd.get('plainLanguage'),
      appliesTo: fd.getAll('appliesTo'),
      blocking: fd.get('blocking') === 'on',
      mode: rule?.mode || 'add',
      bindToStep: rule?.bindToStep || '',
      insertBefore: rule?.insertBefore || '',
      capture: rule?.capture || { label: fd.get('title') },
      check: {
        kind: fd.get('kind'),
        unit: fd.get('unit') || '',
        min: fd.get('min'),
        max: fd.get('max'),
        photoMin: fd.get('photoMin'),
      },
    };
    try {
      await api(rule ? `/api/code-rules/${rule.id}` : '/api/code-rules',
        { method: 'POST', body: JSON.stringify(body) });
      toast('Saved', 'good');
      closeSheet();
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
  });

  $('#rmrule')?.addEventListener('click', async () => {
    if (!confirm('Delete this rule?')) return;
    await api(`/api/code-rules/${rule.id}/archive`, { method: 'POST' });
    closeSheet();
    refresh();
  });
}

function verifySheet(ruleId) {
  const rule = (STATE.codeRules || []).find((r) => r.id === ruleId);
  if (!rule) return;

  if (rule.enforceable) {
    openSheet(`
      <div class="sheet-head"><h2>Stop enforcing this?</h2><button class="closex" data-close>&times;</button></div>
      <div class="sheet-body">
        <p><b>${esc(rule.title)}</b> — ${esc(rule.requirementText)}</p>
        <p class="muted small">Confirmed by ${esc(rule.verifiedBy)}. Turning this off leaves the rule
          on file but stops it blocking any job.</p>
        <button class="btn btn--red btn--block" id="unverify">Stop enforcing</button>
      </div>`);
    $('#unverify').addEventListener('click', async () => {
      await api(`/api/code-rules/${rule.id}/verify`, { method: 'POST', body: JSON.stringify({ verified: false }) });
      closeSheet();
      refresh();
    });
    return;
  }

  openSheet(`
    <div class="sheet-head"><h2>Confirm this rule</h2><button class="closex" data-close>&times;</button></div>
    <div class="sheet-body">
      <p><b>${esc(rule.title)}</b></p>
      <p class="small" style="margin-top:4px">
        ${rule.requirementText
          ? `This will start enforcing: <b>${esc(rule.requirementText)}</b>`
          : '<span style="color:var(--red);font-weight:700">Fill in the value first — there is nothing to check against yet.</span>'}
      </p>
      ${rule.citation ? `<p class="small muted">${esc(rule.citation)}</p>` : ''}
      <div class="warnbox" style="margin:16px 0">
        <p class="small" style="margin:0">You are stating that you checked this against the code your
        jurisdiction actually adopted. From the moment you confirm it, it blocks your crew's work.
        Your name goes on it.</p>
      </div>
      <form id="verifyform">
        <label class="field"><span>Your name</span>
          <input type="text" name="verifiedBy" required placeholder="Who is standing behind this"></label>
        <label class="field"><span>How did you confirm it?</span>
          <textarea name="verifiedSource" placeholder="e.g. Called the county building dept, spoke to J. Miller, 14 Mar"></textarea></label>
        <button class="btn btn--green btn--block" type="submit" ${rule.requirementText ? '' : 'disabled'}>
          Confirm — start enforcing</button>
      </form>
    </div>`);

  $('#verifyform').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/code-rules/${rule.id}/verify`, {
        method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
      });
      toast('Now enforcing', 'good');
      closeSheet();
      refresh();
    } catch (err) { toast(err.message, 'bad'); }
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
  const views = { jobs: jobsTab, checklists: checklistsTab, code: codeTab, crew: crewTab, setup: setupTab };
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
  $('#newjur')?.addEventListener('click', () => jurisdictionSheet(null));

  for (const el of document.querySelectorAll('[data-openjur]')) {
    el.addEventListener('click', () => { openJurisdiction = el.dataset.openjur; render(); });
  }
  $('[data-backjur]')?.addEventListener('click', () => { openJurisdiction = null; render(); });
  for (const el of document.querySelectorAll('[data-editjur]')) {
    el.addEventListener('click', (e) => { e.stopPropagation(); jurisdictionSheet(el.dataset.editjur); });
  }
  for (const el of document.querySelectorAll('[data-newrule]')) {
    el.addEventListener('click', () => ruleSheet(null, el.dataset.newrule));
  }
  for (const el of document.querySelectorAll('[data-editrule]')) {
    el.addEventListener('click', () => ruleSheet(el.dataset.editrule));
  }
  for (const el of document.querySelectorAll('[data-verify]')) {
    el.addEventListener('click', () => verifySheet(el.dataset.verify));
  }
  for (const el of document.querySelectorAll('[data-starter]')) {
    el.addEventListener('click', async () => {
      const r = await api(`/api/jurisdictions/${el.dataset.starter}/starter-rules`, { method: 'POST' });
      toast(`${r.added} subjects added — all blank, fill them in`, 'good');
      refresh();
    });
  }

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
