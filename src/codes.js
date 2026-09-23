/**
 * Code rules: jurisdiction requirements attached to checklist steps.
 *
 * The hard line this module draws: a rule only has teeth once a human has
 * verified it against the code their jurisdiction actually adopted. An
 * unverified rule is shown to the office as "needs confirming" and is never
 * shown to the crew as a requirement, never blocks a step, and never blocks a
 * job. Nothing here invents a number - every value comes from whoever typed it
 * in, and the app records who that was and when.
 */

/** A step's input bounds ("that's not a real measurement") are NOT the code
    check ("that measurement violates code"). They have different consequences,
    so they are kept in different fields and never merged. */
export function describeRule(rule) {
  const c = rule.check || {};
  const unit = c.unit ? ` ${c.unit}` : '';
  switch (c.kind) {
    case 'min': return c.min == null ? '' : `Must be at least ${c.min}${unit}`;
    case 'max': return c.max == null ? '' : `Must be no more than ${c.max}${unit}`;
    case 'range':
      return c.min == null || c.max == null ? '' : `Must be between ${c.min} and ${c.max}${unit}`;
    case 'confirm': return 'Must be confirmed on site';
    case 'photo': return `Must be photographed (${c.photoMin || 1} photo${(c.photoMin || 1) > 1 ? 's' : ''})`;
    default: return '';
  }
}

/** A rule is only enforceable when a person has checked it against the adopted
    code AND the value needed to check against is actually filled in. */
export function isEnforceable(rule) {
  if (!rule.verified) return false;
  const c = rule.check || {};
  if (c.kind === 'min') return c.min != null;
  if (c.kind === 'max') return c.max != null;
  if (c.kind === 'range') return c.min != null && c.max != null;
  return c.kind === 'confirm' || c.kind === 'photo';
}

export function ruleSummary(rule) {
  return {
    ruleId: rule.id,
    title: rule.title,
    citation: rule.citation || '',
    sourceUrl: rule.sourceUrl || '',
    plainLanguage: rule.plainLanguage || '',
    jurisdictionName: rule.jurisdictionName || '',
    check: { ...(rule.check || {}) },
    requirementText: describeRule(rule),
    blocking: !!rule.blocking,
    verified: !!rule.verified,
    verifiedBy: rule.verifiedBy || '',
    verifiedAt: rule.verifiedAt || null,
    enforceable: isEnforceable(rule),
    lookupHint: rule.lookupHint || '',
  };
}

/**
 * Measures a step's recorded answer against the code rule riding on it.
 * `pending` = nothing recorded yet. `unverified` = a rule nobody has confirmed,
 * so it is informational only and carries no weight.
 */
export function evaluateCode(step, entry, override) {
  const rule = step.codeRule;
  if (!rule) return null;

  const base = { stepId: step.id, label: step.label, rule };
  if (!rule.enforceable) {
    return { ...base, state: 'unverified', message: 'Not confirmed against the adopted code yet.' };
  }

  const c = rule.check || {};
  const photos = entry?.photos || [];
  const raw = entry?.value;

  if (c.kind === 'photo') {
    const need = c.photoMin || 1;
    if (photos.length >= need) return { ...base, state: 'pass', message: `${photos.length} photo(s) on file.` };
    return { ...base, state: 'pending', message: `Needs ${need} photo(s), has ${photos.length}.` };
  }

  if (c.kind === 'confirm') {
    if (raw === true) return { ...base, state: 'pass', message: 'Confirmed on site.' };
    return { ...base, state: 'pending', message: 'Not confirmed yet.' };
  }

  if (raw === null || raw === undefined || raw === '') {
    return { ...base, state: 'pending', message: 'Not measured yet.' };
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return { ...base, state: 'pending', message: 'Not measured yet.' };

  const unit = c.unit ? ` ${c.unit}` : '';
  let ok = true;
  let message = '';
  if (c.kind === 'min') {
    ok = value >= c.min;
    message = ok ? `${value}${unit} meets the ${c.min}${unit} minimum.`
                 : `${value}${unit} is under the ${c.min}${unit} minimum.`;
  } else if (c.kind === 'max') {
    ok = value <= c.max;
    message = ok ? `${value}${unit} is within the ${c.max}${unit} limit.`
                 : `${value}${unit} exceeds the ${c.max}${unit} limit.`;
  } else if (c.kind === 'range') {
    ok = value >= c.min && value <= c.max;
    message = ok ? `${value}${unit} is inside the ${c.min}–${c.max}${unit} range.`
                 : `${value}${unit} is outside the ${c.min}–${c.max}${unit} range.`;
  }

  if (ok) return { ...base, state: 'pass', message, value };

  // A failure the office has looked at and accepted stays visible, but stops
  // blocking. Without this escape hatch crews learn to type a passing number.
  if (override?.status === 'granted') {
    return {
      ...base, state: 'waived', value,
      message: `${message} Variance approved by the office: ${override.note || 'no reason given'}`,
    };
  }
  return { ...base, state: 'fail', message, value };
}

/** Every code finding on a job, in checklist order. */
export function codeFindings(job) {
  const out = [];
  for (const step of job.templateSnapshot?.steps || []) {
    if (!step.codeRule) continue;
    const finding = evaluateCode(step, job.entries?.[step.id], job.overrides?.[step.id]);
    if (finding) out.push({ ...finding, override: job.overrides?.[step.id] || null });
  }
  return out;
}

/** The findings that stop a job dead. */
export function codeBlockers(job) {
  return codeFindings(job).filter((f) => f.state === 'fail' && f.rule.blocking);
}

/** True when this step's code rule is failing hard enough to hold up the job. */
export function stepBlockedByCode(step, entry, override) {
  const finding = evaluateCode(step, entry, override);
  return !!finding && finding.state === 'fail' && finding.rule.blocking;
}

export function codeSummary(job) {
  const findings = codeFindings(job);
  return {
    total: findings.length,
    pass: findings.filter((f) => f.state === 'pass').length,
    fail: findings.filter((f) => f.state === 'fail').length,
    waived: findings.filter((f) => f.state === 'waived').length,
    pending: findings.filter((f) => f.state === 'pending').length,
    unverified: findings.filter((f) => f.state === 'unverified').length,
  };
}

// ------------------------------------------------------- attaching to a job

/** Most specific jurisdiction wins, and its parents still apply: a city rule
    sits on top of the county's, which sits on top of the state's. */
export function rulesForJob(allRules, jurisdictions, jurisdictionId, templateId) {
  const chain = jurisdictionChain(jurisdictions, jurisdictionId);
  const ids = new Set(chain.map((j) => j.id));
  return allRules.filter((r) =>
    !r.archived
    && ids.has(r.jurisdictionId)
    && (!r.appliesTo?.length || r.appliesTo.includes(templateId)));
}

export function jurisdictionChain(jurisdictions, jurisdictionId) {
  const target = jurisdictions.find((j) => j.id === jurisdictionId);
  if (!target) return [];
  return jurisdictions.filter((j) => {
    if (j.archived) return false;
    if (j.id === target.id) return true;
    if (j.state !== target.state) return false;
    // a state-wide entry (no county) covers every county in that state
    if (!j.county && !j.city) return true;
    return !!target.county && j.county === target.county && !j.city;
  });
}

/**
 * Writes the rules into a template snapshot. `bind` hangs the rule on a step
 * that already exists so nothing gets measured twice; `add` inserts a new step.
 * This runs once, when the job is assigned, and the result is frozen into the
 * job - so the record shows the code as it stood on the day of the work.
 */
export function applyCodeRules(snapshot, rules, jurisdictionName) {
  const steps = structuredClone(snapshot.steps || []);

  for (const rule of rules) {
    const meta = ruleSummary({ ...rule, jurisdictionName: rule.jurisdictionName || jurisdictionName });
    const enforced = meta.enforceable && meta.blocking;

    if (rule.mode === 'bind') {
      const target = steps.find((s) => s.id === rule.bindToStep);
      if (target) {
        target.codeRule = meta;
        if (enforced) target.required = true;
        continue;
      }
      // The step it wanted is gone (template was edited) - add one instead so
      // the requirement is not silently dropped.
    }

    const capture = rule.capture || {};
    const type = capture.type || (rule.check?.kind === 'photo' ? 'photo'
      : rule.check?.kind === 'confirm' ? 'check' : 'number');

    const step = {
      id: `code_${rule.id}`,
      type,
      label: capture.label || rule.title,
      help: capture.help || rule.plainLanguage || '',
      required: enforced,
      codeRule: meta,
    };
    if (type === 'photo') {
      step.min = Math.max(1, rule.check?.photoMin || capture.photoMin || 1);
      step.max = Math.max(step.min, capture.photoMax || 6);
    }
    if (type === 'number' && rule.check?.unit) step.unit = rule.check.unit;

    const at = rule.insertBefore ? steps.findIndex((s) => s.id === rule.insertBefore) : -1;
    if (at >= 0) steps.splice(at, 0, step);
    else steps.push(step);
  }

  return { ...snapshot, steps };
}
