/**
 * Regional starting points.
 *
 * A pack sets up the jurisdictions in the right shape for a state and points
 * each rule at the exact regulation to read. It still ships every value blank
 * and unverified — the citations tell you where to look, they do not tell you
 * what the number is. Somebody in your office reads the regulation, types the
 * value and signs for it before anything enforces.
 */

export const CODE_PACKS = {
  ky: {
    id: 'ky',
    name: 'Kentucky',
    blurb: 'Kentucky runs one statewide plumbing code, so the plumbing rules sit at the '
      + 'state level and apply to every county you add. The county entries carry the things '
      + 'that genuinely are local — road and right-of-way cuts, and which health department '
      + 'the state inspector works out of.',
    jurisdictions: [
      {
        key: 'state',
        name: 'Kentucky — statewide',
        state: 'KY',
        county: '',
        city: '',
        codeBase: 'Kentucky State Plumbing Code — 815 KAR Chapter 20',
        notes: 'Kentucky has a single statewide plumbing code (815 KAR Chapter 20, under KRS 318.130). '
          + 'Permits and inspections are run by the state Department of Housing, Buildings and '
          + 'Construction, Division of Plumbing — not by the county — and state plumbing inspectors '
          + 'work out of local health departments on a weekly itinerary. Under KRS 318.140 a local '
          + 'government may adopt and enforce the state code with its own inspectors; check whether '
          + 'Grant or Pendleton has done that. Water districts can also carry their own service '
          + 'requirements on top of the plumbing code.',
      },
      {
        key: 'grant',
        state: 'KY',
        county: 'Grant',
        city: '',
        codeBase: 'Statewide plumbing code applies — local permits cover road and right-of-way work',
        notes: 'Plumbing rules come from the Kentucky entry above. What is actually local here: '
          + 'county road department and city public works permits for cutting or crossing a '
          + 'right-of-way, and the water district serving the job. Record the inspector itinerary '
          + 'and the health department they work out of.',
      },
      {
        key: 'pendleton',
        state: 'KY',
        county: 'Pendleton',
        city: '',
        codeBase: 'Statewide plumbing code applies — local permits cover road and right-of-way work',
        notes: 'Same as Grant: the plumbing rules live on the Kentucky entry. Fill in the county '
          + 'road department and water district contacts, and the state inspector itinerary.',
      },
    ],

    rules: [
      // ---- statewide plumbing: water service -------------------------------
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_water_line'],
        title: 'Minimum cover over water service',
        mode: 'bind',
        bindToStep: 'depth',
        check: { kind: 'min', unit: 'inches', min: null },
        citation: '815 KAR 20:120 — Water supply and distribution',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/120/',
        lookupHint: 'Read 815 KAR 20:120 in the current DHBC code book. Then check separately whether '
          + 'the water district serving the job requires more — the PSC has had to rule on where the '
          + 'state plumbing code stops and a water district\'s own rules begin, so the two are not '
          + 'always the same number. Use the deeper of the two.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_water_line'],
        title: 'Separation between water service and sewer',
        mode: 'add',
        insertBefore: 'pipe_in_trench',
        capture: {
          type: 'number',
          label: 'Clear distance from the sewer line',
          help: 'Measure it in the open trench, before anything gets covered.',
        },
        check: { kind: 'min', unit: 'inches', min: null },
        citation: '815 KAR 20:120 and 815 KAR 20:130',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/120/',
        lookupHint: 'Check both regulations — the requirement may be split between the water supply '
          + 'section and the house sewer section, and may be stated as separate horizontal and '
          + 'vertical figures. Record whichever one your inspector measures to.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_water_line'],
        title: 'Approved pipe material for water service',
        mode: 'add',
        insertBefore: 'pipe_in_trench',
        capture: {
          type: 'check',
          label: 'Pipe material is on the Kentucky approved parts list',
          help: 'If you are not certain the material is approved, stop and call the office.',
        },
        check: { kind: 'confirm' },
        citation: '815 KAR 20:020 — Parts or materials list',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/020/',
        lookupHint: 'Kentucky keeps an approved parts and materials list rather than leaving it to the '
          + 'model code. Write the materials you actually run into the plain-language field so the crew '
          + 'can check it against what is on the truck.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_water_line'],
        title: 'Locating means for non-metallic water service',
        mode: 'bind',
        bindToStep: 'tracer',
        check: { kind: 'photo', photoMin: 1 },
        citation: '815 KAR 20:120; plus the water district\'s own specification',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/120/',
        lookupHint: 'Confirm what the code requires over plastic service, then check the water '
          + 'district — they often specify wire gauge, insulation and where it terminates.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_water_line'],
        title: 'Pressure test — pressure held',
        mode: 'add',
        insertBefore: 'backfill',
        capture: { type: 'number', label: 'Test pressure held (psi)', help: 'Read it off the gauge.' },
        check: { kind: 'min', unit: 'psi', min: null },
        citation: '815 KAR 20:150 — Inspection and tests',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/150/',
        lookupHint: '815 KAR 20:150 is the inspection and testing regulation. Confirm the required '
          + 'pressure, the duration, and whether the test has to be witnessed by the inspector.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_water_line'],
        title: 'Pressure test — duration held',
        mode: 'add',
        insertBefore: 'backfill',
        capture: { type: 'number', label: 'Minutes the test was held', help: 'Start the clock when the gauge settles.' },
        check: { kind: 'min', unit: 'minutes', min: null },
        citation: '815 KAR 20:150 — Inspection and tests',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/150/',
        lookupHint: 'Stated alongside the test pressure in 815 KAR 20:150.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_water_line'],
        title: 'State inspection before the water trench is covered',
        mode: 'add',
        insertBefore: 'backfill',
        capture: {
          type: 'check',
          label: 'Inspection passed — cleared to backfill',
          help: 'Do not cover this trench until it is inspected. Uncovering it later is our cost.',
        },
        check: { kind: 'confirm' },
        citation: '815 KAR 20:150 — Inspection and tests',
        sourceUrl: 'https://dhbc.ky.gov/newstatic_info.aspx?static_id=337',
        lookupHint: 'Kentucky plumbing inspections are done by state inspectors from the DHBC Division '
          + 'of Plumbing, who work out of local health departments on a weekly itinerary. Get the '
          + 'itinerary for Grant and Pendleton, find out how much notice they need, and put that in the '
          + 'jurisdiction notes so the crew can plan around it.',
      },

      // ---- statewide: locates ---------------------------------------------
      {
        jurisdiction: 'state',
        appliesTo: [],
        title: 'Locate ticket is valid and the waiting period has run',
        mode: 'bind',
        bindToStep: 'ticket_live',
        check: { kind: 'confirm' },
        citation: 'KRS 367.4901–367.4917 — Underground Facility Damage Prevention Act',
        sourceUrl: 'https://kentucky811.org/resources/law/',
        lookupHint: 'Kentucky 811 is the one-call centre. The notice period before digging is commonly '
          + 'cited as two working days — confirm the current figure and how long a ticket stays valid '
          + 'at kentucky811.org, then write both into the plain-language field. There are statutory '
          + 'fines for digging without it.',
      },

      // ---- statewide: sewer ------------------------------------------------
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_sewer_lateral'],
        title: 'Minimum fall per foot on the house sewer',
        mode: 'bind',
        bindToStep: 'fall',
        check: { kind: 'min', unit: 'inches per foot', min: null },
        citation: '815 KAR 20:130 — House sewers and storm water piping; methods of installation',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/130/',
        lookupHint: 'Slope is normally set by pipe diameter — the figure for 4 inch is not the figure '
          + 'for 6 inch. Record the one for the size you actually run, and check whether a maximum '
          + 'slope applies as well.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_sewer_lateral'],
        title: 'Cleanout placement',
        mode: 'bind',
        bindToStep: 'cleanout',
        check: { kind: 'photo', photoMin: 1 },
        citation: '815 KAR 20:130 — House sewers and storm water piping',
        sourceUrl: 'https://apps.legislature.ky.gov/law/kar/titles/815/020/130/',
        lookupHint: 'Confirm where cleanouts are required and the maximum run between them, then write '
          + 'it in plain words for the crew.',
      },
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_sewer_lateral'],
        title: 'State inspection before the sewer trench is covered',
        mode: 'add',
        insertBefore: 'bedding',
        capture: {
          type: 'check',
          label: 'Inspection passed — cleared to backfill',
          help: 'Do not cover this trench until it is inspected.',
        },
        check: { kind: 'confirm' },
        citation: '815 KAR 20:150 — Inspection and tests',
        sourceUrl: 'https://dhbc.ky.gov/newstatic_info.aspx?static_id=337',
        lookupHint: 'Same state inspector as the water side. Confirm whether a sanitation district or '
          + 'city utility also wants to see the lateral before it is covered.',
      },

      // ---- statewide: excavation safety ------------------------------------
      {
        jurisdiction: 'state',
        appliesTo: ['tpl_excavation'],
        title: 'Trench protective system',
        mode: 'add',
        insertBefore: 'spoil',
        capture: {
          type: 'check',
          label: 'Protective system in place, or this excavation is below the depth that requires one',
          help: 'Sloping, benching, a trench box or shoring. If you are unsure, nobody goes in.',
        },
        check: { kind: 'confirm' },
        citation: '29 CFR 1926 Subpart P, as enforced by Kentucky OSH',
        sourceUrl: 'https://www.osha.gov/laws-regs/regulations/standardnumber/1926/1926SubpartP',
        lookupHint: 'Kentucky runs its own OSHA-approved state plan, so confirm the Kentucky OSH '
          + 'requirements rather than only the federal text — a state plan can be stricter. Confirm the '
          + 'depth threshold and the competent-person requirement.',
      },

      // ---- county level: the parts that genuinely are local -----------------
      {
        jurisdiction: 'grant',
        appliesTo: [],
        title: 'Road or right-of-way permit (Grant County)',
        mode: 'add',
        insertBefore: 'before_wide',
        capture: {
          type: 'check',
          label: 'Right-of-way permit in hand for this cut or crossing',
          help: 'Only if the work touches a county road, city street or state right-of-way.',
        },
        check: { kind: 'confirm' },
        citation: 'Grant County road department / city public works',
        lookupHint: 'This one really is local, unlike the plumbing rules. Find out who issues the permit '
          + 'for a county road versus a city street versus a state highway, how long it takes, and what '
          + 'restoration spec they hold you to. Put the contacts in the jurisdiction notes.',
      },
      {
        jurisdiction: 'pendleton',
        appliesTo: [],
        title: 'Road or right-of-way permit (Pendleton County)',
        mode: 'add',
        insertBefore: 'before_wide',
        capture: {
          type: 'check',
          label: 'Right-of-way permit in hand for this cut or crossing',
          help: 'Only if the work touches a county road, city street or state right-of-way.',
        },
        check: { kind: 'confirm' },
        citation: 'Pendleton County road department / city public works',
        lookupHint: 'Same question as Grant, different office. Confirm who issues it, the lead time and '
          + 'the restoration spec.',
      },
    ],
  },
};

export const packList = () => Object.values(CODE_PACKS).map((p) => ({
  id: p.id,
  name: p.name,
  blurb: p.blurb,
  jurisdictionCount: p.jurisdictions.length,
  ruleCount: p.rules.length,
}));
