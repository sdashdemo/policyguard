// lib/facility-attributes.js
// ═══════════════════════════════════════════════════════
// Dynamic Facility Attribute Registry
// ═══════════════════════════════════════════════════════
//
// Each entry defines an "applicability trigger" — a facility characteristic
// that determines whether conditional regulatory obligations apply.
//
// Adding a new trigger requires:
//   1. Add an entry to ATTRIBUTE_REGISTRY below
//   2. Set the value on relevant facility_profiles.attributes JSONB
//   3. That's it. No migration, no schema change, no code change to prompt or validator.
//
// The registry provides:
//   - Deterministic "evidence sentences" for the LLM to quote (solves the anchor problem)
//   - Synonym families and validation paths for the server-side validator
//   - Human-readable labels for the facility onboarding UI
//

export const ATTRIBUTE_REGISTRY = {
  prohibits_restraint: {
    label: 'Restraint/Seclusion',
    description: 'Whether the facility prohibits all physical restraint and seclusion',
    type: 'boolean',
    default_value: null,
    // Evidence sentences — the EXACT text rendered in the facility context block.
    // The LLM quotes these; the validator confirms the quote matches.
    true_text: 'YES — all physical interventions prohibited by policy',
    false_text: 'No — facility permits restraint/seclusion under applicable regulations',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    // Validation config
    validation_path: 'activity', // 'activity' | 'loc' | 'reject'
    trigger_family: ['restraint', 'seclusion', 'physical intervention', 'physical interventions'],
    negation_required: true,
  },

  operates_otp: {
    label: 'OTP/Methadone',
    description: 'Whether the facility operates an Opioid Treatment Program',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility operates an Opioid Treatment Program',
    false_text: 'NO — facility does not operate an OTP or dispense methadone',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['otp', 'methadone', 'opioid treatment program', 'opioid treatment'],
    negation_required: true,
  },

  smoking_in_buildings: {
    label: 'Smoking Policy',
    description: 'Whether smoking is permitted inside facility buildings',
    type: 'boolean',
    default_value: null,
    true_text: 'Smoking permitted in buildings',
    false_text: 'NO — smoking prohibited in all buildings',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['smoking', 'tobacco', 'vaping', 'smoke'],
    negation_required: true,
  },

  patient_work_program: {
    label: 'Patient Work Program',
    description: 'Whether the facility operates patient work-for-wages programs',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility operates patient work programs',
    false_text: 'NO — facility does not operate patient work programs',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['work', 'employment', 'labor', 'wages', 'vocational'],
    negation_required: true,
  },

  // ─── Examples of future attributes (uncomment when needed) ───

  // involuntary_commitment: {
  //   label: 'Involuntary Commitment',
  //   description: 'Whether the facility accepts involuntary/court-ordered patients',
  //   type: 'boolean',
  //   default_value: null,
  //   true_text: 'YES — facility accepts involuntary and court-ordered patients',
  //   false_text: 'NO — facility does not accept involuntary patients',
  //   null_text: null,
  //   validation_path: 'activity',
  //   trigger_family: ['involuntary', 'court-ordered', 'baker act', 'marchman act', 'commitment'],
  //   negation_required: true,
  // },

  // telehealth_services: {
  //   label: 'Telehealth',
  //   description: 'Whether the facility provides telehealth/telemedicine services',
  //   type: 'boolean',
  //   default_value: null,
  //   true_text: 'YES — facility provides telehealth services',
  //   false_text: 'NO — facility does not provide telehealth services',
  //   null_text: null,
  //   validation_path: 'activity',
  //   trigger_family: ['telehealth', 'telemedicine', 'remote', 'virtual'],
  //   negation_required: true,
  // },

  // electroconvulsive_therapy: {
  //   label: 'ECT',
  //   description: 'Whether the facility provides electroconvulsive therapy',
  //   type: 'boolean',
  //   default_value: null,
  //   true_text: 'YES — facility provides electroconvulsive therapy',
  //   false_text: 'NO — facility does not provide electroconvulsive therapy',
  //   null_text: null,
  //   validation_path: 'activity',
  //   trigger_family: ['electroconvulsive', 'ect', 'electroshock'],
  //   negation_required: true,
  // },
};


// ═══════════════════════════════════════════════════════
// Render facility context block for the LLM prompt
// ═══════════════════════════════════════════════════════
//
// Takes a facility profile (with .attributes JSONB) and produces
// deterministic, quotable text. Every line is anchored to a registry
// entry, so the validator can mechanically verify any quote the LLM makes.

export function renderFacilityContext(facility) {
  if (!facility) return '';

  const attrs = facility.attributes || {};
  const lines = [
    '═══════════════════════════════════════════════════════',
    'FACILITY CONTEXT',
    '═══════════════════════════════════════════════════════',
    `Facility: ${facility.name} (${facility.abbreviation})`,
    `State: ${facility.state}`,
    `Levels of Care: ${(facility.levels_of_care || []).join(', ') || 'Not specified'}`,
    `Services Offered: ${(facility.services_offered || []).join(', ') || 'Not specified'}`,
    `Services Excluded: ${(facility.services_excluded || []).join(', ') || 'None specified'}`,
    `Accreditations: ${(facility.accreditations || []).join(', ') || 'Not specified'}`,
  ];

  // Render each registered attribute
  for (const [key, def] of Object.entries(ATTRIBUTE_REGISTRY)) {
    const value = attrs[key] ?? def.default_value ?? null;
    let text;
    if (value === true) {
      text = def.true_text;
    } else if (value === false) {
      text = def.false_text;
    } else {
      text = def.null_text; // renders UNKNOWN for unconfigured attributes
    }
    if (text !== null && text !== undefined) {
      lines.push(`${def.label}: ${text}`);
    }
  }

  return '\n' + lines.join('\n');
}


// ═══════════════════════════════════════════════════════
// Build the full facility context string for substring validation
// (Validator uses this to confirm inapplicability_reason is a real substring)
// ═══════════════════════════════════════════════════════

export function buildFacilityContextString(facility) {
  if (!facility) return '';

  const attrs = facility.attributes || {};
  const parts = [
    `Facility: ${facility.name} (${facility.abbreviation})`,
    `State: ${facility.state}`,
    `Levels of Care: ${(facility.levels_of_care || []).join(', ') || 'Not specified'}`,
    `Services Offered: ${(facility.services_offered || []).join(', ') || 'Not specified'}`,
    `Services Excluded: ${(facility.services_excluded || []).join(', ') || 'None specified'}`,
    `Accreditations: ${(facility.accreditations || []).join(', ') || 'Not specified'}`,
  ];

  for (const [key, def] of Object.entries(ATTRIBUTE_REGISTRY)) {
    const value = attrs[key] ?? def.default_value ?? null;
    let text;
    if (value === true) text = def.true_text;
    else if (value === false) text = def.false_text;
    else text = def.null_text;
    if (text !== null && text !== undefined) {
      parts.push(`${def.label}: ${text}`);
    }
  }

  return parts.join('\n');
}


// ═══════════════════════════════════════════════════════
// Validation helpers — used by the assess route validator
// ═══════════════════════════════════════════════════════

/**
 * Given a trigger_span string, find which attribute family (if any) it belongs to.
 * Returns { key, def } or null if no match.
 */
export function findTriggerFamily(triggerSpan) {
  const lower = triggerSpan.toLowerCase();
  for (const [key, def] of Object.entries(ATTRIBUTE_REGISTRY)) {
    if (def.trigger_family && def.trigger_family.some(s => lower.includes(s))) {
      return { key, def };
    }
  }
  return null;
}

/**
 * Check whether a trigger family's synonyms appear in the inapplicability_reason.
 */
export function reasonMatchesFamily(reason, family) {
  const lower = reason.toLowerCase();
  return family.trigger_family.some(s => lower.includes(s));
}

/**
 * Check whether the reason contains a negation marker.
 */
export function reasonHasNegation(reason) {
  const lower = reason.toLowerCase();
  return NEGATION_MARKERS.some(m => lower.includes(m));
}

const NEGATION_MARKERS = [
  'prohibit', 'does not', 'no —', 'not operate', 'not permitted',
  'excluded', 'prohibited', 'all physical interventions prohibited',
  'no —',
];


// ═══════════════════════════════════════════════════════
// Boilerplate blacklist for inapplicability_reason validation
// ═══════════════════════════════════════════════════════

export const BOILERPLATE_BLACKLIST = new Set([
  'Not specified',
  'None specified',
  'No',
  'YES',
  'Services Excluded: None specified',
  'Smoking Policy: Not specified',
  'Accreditations: Not specified',
  'UNKNOWN — not configured (obligation APPLIES by default)',
]);


// ═══════════════════════════════════════════════════════
// Known LOC keywords for Path A validation
// ═══════════════════════════════════════════════════════

export const LOC_KEYWORDS = new Set([
  'residential', 'php', 'iop', 'op', 'outpatient', 'detox',
  'inpatient', 'mh_rtf', 'day/night', 'day treatment',
]);


// ═══════════════════════════════════════════════════════
// Discovery: Extract potential triggers from obligation text
// ═══════════════════════════════════════════════════════
//
// Scans obligation requirement text for conditional language patterns
// and returns attribute keys that the obligation might be gated on.
// Used during facility onboarding to surface "you need to set this attribute."

export function discoverTriggersFromObligation(requirementText) {
  const lower = (requirementText || '').toLowerCase();
  const matches = [];

  // Check each registered attribute's trigger family
  for (const [key, def] of Object.entries(ATTRIBUTE_REGISTRY)) {
    if (!def.trigger_family) continue;
    const hit = def.trigger_family.some(term => {
      // Look for conditional patterns around the trigger term
      const idx = lower.indexOf(term);
      if (idx === -1) return false;
      // Check surrounding context for conditional language
      const start = Math.max(0, idx - 60);
      const window = lower.substring(start, idx + term.length + 60);
      return /\b(if|when|where|for facilities that|for programs that|in (buildings|facilities|programs) (where|that)|applicable to)\b/.test(window)
        || /\b(operates?|provides?|permits?|uses?|offers?|maintains?)\b/.test(window);
    });
    if (hit) {
      matches.push({ key, label: def.label, description: def.description });
    }
  }

  return matches;
}

/**
 * Scan all obligations for a given reg source and return a deduplicated
 * list of attribute keys that facilities need to have set.
 * Used to build the "facility onboarding checklist" for a new state.
 */
export function discoverAttributesForRegSource(obligations) {
  const seen = new Set();
  const results = [];

  for (const obl of obligations) {
    const triggers = discoverTriggersFromObligation(obl.requirement);
    for (const t of triggers) {
      if (!seen.has(t.key)) {
        seen.add(t.key);
        results.push(t);
      }
    }
  }

  return results;
}
