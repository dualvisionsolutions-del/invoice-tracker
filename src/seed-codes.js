/**
 * Starter code rules.
 *
 * Every one of these ships with NO value and unverified. They name a subject
 * that jurisdictions regulate and tell you where the number lives - they do not
 * tell you what the number is, because that depends on the code edition your
 * state adopted and whatever your county and city amended on top of it.
 *
 * Fill in the value, paste the citation, mark it verified, and it starts
 * enforcing. Until then the app treats it as a note, not a requirement.
 */

export const SEED_CODE_RULES = [
  // ---------------------------------------------------------- water service
  {
    key: 'water_min_cover',
    appliesTo: ['tpl_water_line'],
    title: 'Minimum cover over water service',
    mode: 'bind',
    bindToStep: 'depth',
    check: { kind: 'min', unit: 'inches', min: null },
    blocking: true,
    lookupHint: 'Almost always driven by local frost depth rather than the model code itself. '
      + 'Your county or city building department publishes a frost depth; the water purveyor '
      + 'may require more. Ask your inspector for the number they actually measure to.',
  },
  {
    key: 'water_sewer_separation',
    appliesTo: ['tpl_water_line'],
    title: 'Separation between water service and sewer',
    mode: 'add',
    insertBefore: 'pipe_in_trench',
    capture: {
      type: 'number',
      label: 'Clear distance from the sewer line',
      help: 'Measure it in the open trench before anything gets covered.',
    },
    check: { kind: 'min', unit: 'inches', min: null },
    blocking: true,
    lookupHint: 'Both the IPC and the UPC set horizontal and vertical separation between a '
      + 'water service and a building sewer, and many health departments tighten it. Confirm '
      + 'which figure your jurisdiction enforces and whether it is measured edge-to-edge.',
  },
  {
    key: 'water_pipe_material',
    appliesTo: ['tpl_water_line'],
    title: 'Approved pipe material for water service',
    mode: 'add',
    insertBefore: 'pipe_in_trench',
    capture: {
      type: 'check',
      label: 'Pipe material is on the approved list for this jurisdiction',
      help: 'If you are not certain the material is approved here, stop and call the office.',
    },
    check: { kind: 'confirm' },
    blocking: true,
    lookupHint: 'Your adopted plumbing code lists approved water service materials, and local '
      + 'amendments often strike some of them. Write the approved list into the plain-language '
      + 'field so the crew can check it against what is on the truck.',
  },
  {
    key: 'water_tracer_wire',
    appliesTo: ['tpl_water_line'],
    title: 'Locating means for non-metallic pipe',
    mode: 'bind',
    bindToStep: 'tracer',
    check: { kind: 'photo', photoMin: 1 },
    blocking: true,
    lookupHint: 'Most jurisdictions require tracer wire or an equivalent locating means over '
      + 'plastic water service, and some specify wire gauge, insulation and where it terminates.',
  },
  {
    key: 'water_pressure_test',
    appliesTo: ['tpl_water_line'],
    title: 'Pressure test — pressure held',
    mode: 'add',
    insertBefore: 'backfill',
    capture: {
      type: 'number',
      label: 'Test pressure held (psi)',
      help: 'Read it off the gauge. Photograph the gauge in the step above.',
    },
    check: { kind: 'min', unit: 'psi', min: null },
    blocking: true,
    lookupHint: 'Your code sets a test pressure and a duration for water service. Confirm both, '
      + 'and whether your inspector requires the test to be witnessed.',
  },
  {
    key: 'water_pressure_duration',
    appliesTo: ['tpl_water_line'],
    title: 'Pressure test — duration held',
    mode: 'add',
    insertBefore: 'backfill',
    capture: {
      type: 'number',
      label: 'Minutes the test was held',
      help: 'Start the clock when the gauge settles.',
    },
    check: { kind: 'min', unit: 'minutes', min: null },
    blocking: true,
    lookupHint: 'Stated alongside the test pressure in your adopted code.',
  },
  {
    key: 'water_inspection_before_backfill',
    appliesTo: ['tpl_water_line'],
    title: 'Inspection before the trench is covered',
    mode: 'add',
    insertBefore: 'backfill',
    capture: {
      type: 'check',
      label: 'Inspection passed — cleared to backfill',
      help: 'Do not cover this trench until it is inspected. Uncovering it later is our cost, not theirs.',
    },
    check: { kind: 'confirm' },
    blocking: true,
    lookupHint: 'Nearly every jurisdiction requires underground work to be inspected before it '
      + 'is covered. Confirm who inspects, how much notice they need, and whether a photo '
      + 'inspection is accepted.',
  },

  // ---------------------------------------------------------- sewer lateral
  {
    key: 'sewer_min_fall',
    appliesTo: ['tpl_sewer_lateral'],
    title: 'Minimum fall per foot on the lateral',
    mode: 'bind',
    bindToStep: 'fall',
    check: { kind: 'min', unit: 'inches per foot', min: null },
    blocking: true,
    lookupHint: 'Your code sets minimum slope by pipe diameter — the figure for 4 inch is not '
      + 'the figure for 6 inch. Record the one for the size you actually run, and check whether '
      + 'a maximum slope applies too.',
  },
  {
    key: 'sewer_cleanout',
    appliesTo: ['tpl_sewer_lateral'],
    title: 'Cleanout placement',
    mode: 'bind',
    bindToStep: 'cleanout',
    check: { kind: 'photo', photoMin: 1 },
    blocking: true,
    lookupHint: 'Codes set where cleanouts are required (at the building, at the property line, '
      + 'at bends over a certain angle) and the maximum run between them.',
  },
  {
    key: 'sewer_inspection_before_backfill',
    appliesTo: ['tpl_sewer_lateral'],
    title: 'Inspection before the trench is covered',
    mode: 'add',
    insertBefore: 'bedding',
    capture: {
      type: 'check',
      label: 'Inspection passed — cleared to backfill',
      help: 'Do not cover this trench until it is inspected.',
    },
    check: { kind: 'confirm' },
    blocking: true,
    lookupHint: 'Confirm who inspects laterals in this jurisdiction — it is sometimes the city '
      + 'utility rather than the building department.',
  },

  // ------------------------------------------------------------- excavation
  {
    key: 'exc_protective_system',
    appliesTo: ['tpl_excavation'],
    title: 'Trench protective system',
    mode: 'add',
    insertBefore: 'spoil',
    capture: {
      type: 'check',
      label: 'Protective system is in place, or this excavation is below the depth that requires one',
      help: 'Sloping, benching, a trench box or shoring. If you are unsure, nobody goes in.',
    },
    check: { kind: 'confirm' },
    blocking: true,
    lookupHint: 'This is federal OSHA (29 CFR 1926 Subpart P), not plumbing code, and it applies '
      + 'regardless of jurisdiction. Confirm the depth threshold and the competent-person '
      + 'requirement, and note that some states run their own OSHA plan with stricter rules.',
  },
  {
    key: 'exc_compaction',
    appliesTo: ['tpl_excavation'],
    title: 'Backfill compaction in lifts',
    mode: 'bind',
    bindToStep: 'compaction',
    check: { kind: 'photo', photoMin: 1 },
    blocking: false,
    lookupHint: 'Where the trench crosses a road or right-of-way, the public works department '
      + 'usually specifies lift thickness and a compaction percentage. Under private ground it '
      + 'is often unregulated — which is why this one does not block by default.',
  },
];

/** Turns the starter set into real (blank, unverified) rules for a jurisdiction. */
export function instantiateSeedRules(jurisdiction, makeId) {
  return SEED_CODE_RULES.map((seed) => ({
    id: makeId(),
    jurisdictionId: jurisdiction.id,
    appliesTo: seed.appliesTo || [],
    title: seed.title,
    citation: '',
    sourceUrl: '',
    plainLanguage: '',
    lookupHint: seed.lookupHint || '',
    mode: seed.mode || 'add',
    bindToStep: seed.bindToStep || '',
    insertBefore: seed.insertBefore || '',
    capture: seed.capture || {},
    check: { ...seed.check },
    blocking: seed.blocking !== false,
    verified: false,          // nothing enforces until a person says so
    verifiedBy: '',
    verifiedAt: null,
    verifiedSource: '',
    archived: false,
    createdAt: Date.now(),
  }));
}
