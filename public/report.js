/* Read-only job record. Safe to hand to a customer, an inspector or a lawyer -
   it carries the photos and timestamps but no phone numbers and no crew links. */

const SHARE = location.pathname.split('/')[2] || '';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const stamp = (ts) => ts ? new Date(ts).toLocaleString([], {
  month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
}) : '—';

const src = (photo) => `/media/${photo.photoId}?s=${encodeURIComponent(SHARE)}`;

function photoCaption(photo) {
  const when = photo.capturedAt
    ? new Date(photo.capturedAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  const where = photo.hasGps
    ? ` · <a href="https://www.google.com/maps?q=${photo.lat},${photo.lng}" target="_blank" rel="noopener">map</a>`
    : '';
  return `${when}${where}`;
}

/** Did the crew actually put anything here? Empty steps stay out of the report -
    a customer should see the work that was done, not a list of blanks. */
function hasContent(step) {
  if (step.photos.length) return true;
  if (step.type === 'check') return step.value === true;
  return step.value !== null && step.value !== undefined && String(step.value).trim() !== '';
}

function renderStep(step, byId) {
  if (step.type === 'photo' && step.referenceStep) {
    const before = byId[step.referenceStep];
    if (before?.photos?.length && step.photos.length) {
      return `<div class="rstep">
        <h3>${esc(step.label)}</h3>
        <div class="ba">
          <figure><figcaption>Before</figcaption>
            <img src="${src(before.photos[0])}" alt="Before"></figure>
          <figure><figcaption>After</figcaption>
            <img src="${src(step.photos[0])}" alt="After"></figure>
        </div>
        ${step.photos.length > 1 ? gallery(step.photos.slice(1)) : ''}
      </div>`;
    }
  }

  let answer = '';
  if (step.type === 'check') answer = step.value === true ? '✓ Confirmed' : '—';
  else if (step.type === 'number') answer = step.value ?? '—';
  else if (step.type === 'text' || step.type === 'choice' || step.type === 'signature') {
    answer = step.value ? esc(step.value) : '';
  }

  return `<div class="rstep">
    <h3>${esc(step.label)} ${step.complete ? '<span class="pill pill--green">Done</span>' : ''}</h3>
    ${answer ? `<div class="answer">${answer}</div>` : ''}
    ${step.photos.length ? gallery(step.photos) : ''}
  </div>`;
}

const gallery = (photos) => `<div class="gal">${photos.map((p) => `
  <figure><a href="${src(p)}" target="_blank" rel="noopener"><img src="${src(p)}" alt="" loading="lazy"></a>
  <figcaption>${photoCaption(p)}</figcaption></figure>`).join('')}</div>`;

async function boot() {
  const app = document.getElementById('app');
  let data;
  try {
    const res = await fetch(`/api/report/${SHARE}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Report not found');
    data = await res.json();
  } catch (err) {
    app.innerHTML = `<div style="padding-top:60px;text-align:center">
      <h1>Report not available</h1><p class="muted">${esc(err.message)}</p></div>`;
    return;
  }

  const byId = Object.fromEntries(data.steps.map((s) => [s.id, s]));
  const duration = data.startedAt && data.submittedAt
    ? `${((data.submittedAt - data.startedAt) / 3600000).toFixed(1)} hrs`
    : '—';

  document.title = `${data.checklistName} — ${data.address || data.title}`;

  app.innerHTML = `
    <div class="rep-head">
      <div class="row-between wrapflex">
        <div>
          <div class="small bold muted">${esc(data.companyName)}</div>
          <h1 style="margin-top:4px">${esc(data.checklistName)}</h1>
          <div class="muted" style="margin-top:4px">${esc(data.address || data.title)}</div>
        </div>
        <button class="btn btn--ghost btn--sm noprint" onclick="window.print()">Print / Save PDF</button>
      </div>
      <div class="meta">
        ${data.customer ? `<div><span>Customer</span><b>${esc(data.customer)}</b></div>` : ''}
        <div><span>Completed by</span><b>${esc(data.performedBy)}</b></div>
        <div><span>Started</span><b>${stamp(data.startedAt)}</b></div>
        <div><span>Finished</span><b>${stamp(data.submittedAt)}</b></div>
        <div><span>Time on site</span><b>${duration}</b></div>
        <div><span>Photos on file</span><b>${data.progress.photoCount}</b></div>
      </div>
    </div>
    ${data.status !== 'submitted' && data.status !== 'approved'
      ? `<div class="flag" style="background:var(--amber-bg);color:var(--amber);padding:12px 14px;border-radius:9px;font-weight:650;margin-bottom:18px">
           Work in progress — ${data.progress.done} of ${data.progress.total} items documented so far.
         </div>` : ''}
    ${data.codeFindings?.length ? `
      <div class="rstep">
        <h3>Code compliance${data.jurisdictionName ? ` — ${esc(data.jurisdictionName)}` : ''}</h3>
        <table style="width:100%;border-collapse:collapse;margin-top:10px;font-size:14.5px">
          ${data.codeFindings.map((f) => `
            <tr style="border-bottom:1px solid var(--line-2)">
              <td style="padding:9px 8px 9px 0;vertical-align:top;white-space:nowrap">
                <span class="pill ${f.state === 'pass' ? 'pill--green' : f.state === 'fail' ? 'pill--red' : 'pill--amber'}">
                  ${f.state === 'waived' ? 'variance' : f.state}</span></td>
              <td style="padding:9px 0;vertical-align:top">
                <b>${esc(f.title)}</b><br>
                <span class="muted">${esc(f.message)}</span>
                ${f.waiverNote ? `<br><span class="muted">Approved variance: ${esc(f.waiverNote)}</span>` : ''}
                ${f.citation ? `<br><span class="tiny muted">${esc(f.citation)}</span>` : ''}
              </td>
            </tr>`).join('')}
        </table>
        <p class="tiny muted" style="margin-top:10px">
          Measured and recorded on site at the time of the work.</p>
      </div>` : ''}
    ${data.steps.filter(hasContent).map((s) => renderStep(s, byId)).join('')}
    <p class="tiny muted" style="margin-top:32px;padding-top:16px;border-top:1px solid var(--line-2)">
      Every photo in this report carries the time it was taken and, where the phone allowed it,
      the GPS location. Generated by ${esc(data.companyName)}.</p>`;
}

boot();
