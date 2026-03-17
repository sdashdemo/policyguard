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

const DASH_FOLD_REGEX = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;

const DEFAULT_NEGATION_MARKERS = [
  'does not',
  'do not',
  'not permitted',
  'not allowed',
  'prohibited',
  'prohibit',
  'excluded',
  'does not operate',
  'does not provide',
  'does not use',
  'does not offer',
  'no ',
];

export function canonicalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(DASH_FOLD_REGEX, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const LOC_PATTERNS = [
  { key: 'mh_rtf', regex: /\bmh\s*rtf\b|\bmental health residential treatment facility\b/i },
  { key: 'day/night', regex: /\bday\s*\/?\s*night\b|\bday[- ]night\b/i },
  { key: 'day treatment', regex: /\bday treatment\b/i },
  { key: 'php', regex: /\bphp\b|\bpartial hospitalization\b/i },
  { key: 'iop', regex: /\biop\b|\bintensive outpatient\b/i },
  { key: 'op', regex: /\bop\b|\boutpatient\b/i },
  { key: 'detox', regex: /\bdetox\b|\bdetoxification\b/i },
  { key: 'inpatient', regex: /\binpatient\b/i },
  { key: 'residential', regex: /\bresidential\b|\bres\b(?![a-z])/i },
];

export function extractLocKeywords(input) {
  const text = canonicalize(Array.isArray(input) ? input.join(' ') : input);
  if (!text) return [];

  const matches = [];
  for (const { key, regex } of LOC_PATTERNS) {
    if (regex.test(text)) matches.push(key);
  }
  return [...new Set(matches)];
}

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
    label: 'SAMHSA OTP',
    description: 'Whether the facility operates a SAMHSA-certified Opioid Treatment Program',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility operates a SAMHSA-certified Opioid Treatment Program',
    false_text: 'NO — facility does not operate a SAMHSA-certified OTP',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['otp', 'opioid treatment program', 'samhsa-certified otp'],
    negation_required: true,
    negation_markers: [
      'does not operate a samhsa-certified otp',
      'does not operate an otp',
      'no otp',
    ],
  },

  dispenses_methadone: {
    label: 'Methadone Dispensing',
    description: 'Whether the facility dispenses methadone',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility dispenses methadone',
    false_text: 'NO — facility does not dispense methadone',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['methadone', 'methadone dispensing', 'dispense methadone'],
    negation_required: true,
    negation_markers: [
      'does not dispense methadone',
      'no methadone',
      'facility does not dispense methadone',
    ],
  },

  provides_mat: {
    label: 'Medication Assisted Treatment',
    description: 'Whether the facility provides MAT such as buprenorphine/subutex',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility provides medication assisted treatment',
    false_text: 'NO — facility does not provide medication assisted treatment',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['medication assisted treatment', 'mat', 'buprenorphine', 'subutex'],
    negation_required: true,
    negation_markers: [
      'does not provide medication assisted treatment',
      'does not provide mat',
      'no mat on-site',
    ],
  },

  administers_medications: {
    label: 'Medication Administration',
    description: 'Whether the facility administers medications on site',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility administers medications on site',
    false_text: 'NO — facility does not administer medications on site',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['administer medications', 'medication administration', 'administers medications'],
    negation_required: true,
    negation_markers: [
      'does not administer medications',
      'no medication administration',
      'no medications are administered on site',
    ],
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
    trigger_family: ['smoking', 'tobacco use', 'vaping', 'smoking in buildings'],
    negation_required: true,
    negation_markers: [
      'smoking prohibited',
      'no smoking',
      'smoking prohibited in all buildings',
      'tobacco use prohibited',
      'vaping prohibited',
    ],
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
    trigger_family: ['patient work program', 'patient employment', 'patient labor', 'wages', 'vocational work'],
    negation_required: true,
    negation_markers: [
      'does not operate patient work programs',
      'no patient work programs',
      'patients are not employed for wages',
    ],
  },

  conducts_research: {
    label: 'Research',
    description: 'Whether the facility conducts research or clinical studies',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility conducts research or clinical studies',
    false_text: 'NO — facility does not conduct research or clinical studies',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['research', 'clinical study', 'clinical trial', 'study participation'],
    negation_required: true,
  },

  provides_peer_support: {
    label: 'Peer Support',
    description: 'Whether the facility provides peer support services',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility provides peer support services',
    false_text: 'NO — facility does not provide peer support services',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['peer support', 'peer specialist', 'recovery coach'],
    negation_required: true,
  },

  uses_behavioral_contingencies: {
    label: 'Behavioral Contingencies',
    description: 'Whether the facility uses individualized behavioral contingencies or token-economy style programs',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility uses behavioral contingencies',
    false_text: 'NO — facility does not use behavioral contingencies',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['behavioral contingencies', 'behavior contingency', 'token economy', 'contingency management'],
    negation_required: true,
  },

  provides_intervention_services: {
    label: 'Intervention Services',
    description: 'Whether the facility provides intervention services',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility provides intervention services',
    false_text: 'NO — facility does not provide intervention services',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['intervention services', 'intervention service'],
    negation_required: true,
  },

  is_addictions_receiving_facility: {
    label: 'Addictions Receiving Facility',
    description: 'Whether the facility is an addictions receiving facility',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility is an addictions receiving facility',
    false_text: 'NO — facility is not an addictions receiving facility',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['addictions receiving facility', 'receiving facility'],
    negation_required: true,
  },

  twenty_four_hour_setting: {
    label: '24-Hour Setting',
    description: 'Whether the facility operates as a 24-hour setting',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility is a 24-hour setting',
    false_text: 'NO — facility is not a 24-hour setting',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['24-hour setting', '24 hour setting', 'in 24-hour settings', 'overnight setting'],
    negation_required: true,
    negation_markers: [
      'not a 24-hour setting',
      'not a 24 hour setting',
      'no overnight setting',
    ],
  },

  involuntary_commitment: {
    label: 'Involuntary Commitment',
    description: 'Whether the facility accepts or treats involuntary commitments',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility accepts involuntary commitments',
    false_text: 'NO — facility does not accept involuntary commitments',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['involuntary commitment', 'involuntary placement', 'civil commitment', 'court ordered treatment'],
    negation_required: true,
  },

  operates_pharmacy: {
    label: 'Pharmacy Operation',
    description: 'Whether the facility operates an on-site pharmacy',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility operates an on-site pharmacy',
    false_text: 'NO — facility does not operate an on-site pharmacy',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['operates a pharmacy', 'on-site pharmacy', 'pharmacist-in-charge', 'pharmacy department'],
    negation_required: true,
  },

  provides_aftercare: {
    label: 'Aftercare',
    description: 'Whether the facility provides aftercare services',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility provides aftercare services',
    false_text: 'NO — facility does not provide aftercare services',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['aftercare services', 'aftercare program', 'continuing care program'],
    negation_required: true,
  },

  uses_level_systems: {
    label: 'Level Systems',
    description: 'Whether the facility uses level or phase systems for patients',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility uses level systems',
    false_text: 'NO — facility does not use level systems',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['level system', 'levels system', 'phase system', 'privilege level'],
    negation_required: true,
  },

  provides_primary_physical_health: {
    label: 'Primary Physical Health Care',
    description: 'Whether the facility directly provides primary physical health care',
    type: 'boolean',
    default_value: null,
    true_text: 'YES — facility directly provides primary physical health care',
    false_text: 'NO — facility does not directly provide primary physical health care',
    null_text: 'UNKNOWN — not configured (obligation APPLIES by default)',
    validation_path: 'activity',
    trigger_family: ['primary physical health care', 'primary care', 'directly provide primary physical health care'],
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

  for (const [, def] of Object.entries(ATTRIBUTE_REGISTRY)) {
    const value = attrs[def.label] ?? attrs[Object.keys(ATTRIBUTE_REGISTRY).find(k => ATTRIBUTE_REGISTRY[k] === def)] ?? def.default_value ?? null;
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
 * Returns { key, def, matchedToken } or null if no match.
 */
export function findTriggerFamily(triggerSpan) {
  const lower = canonicalize(triggerSpan);
  const matches = [];

  for (const [key, def] of Object.entries(ATTRIBUTE_REGISTRY)) {
    const family = def.trigger_family || [];
    const matchedToken = family
      .map(s => canonicalize(s))
      .filter(s => lower.includes(s))
      .sort((a, b) => b.length - a.length)[0];

    if (matchedToken) {
      matches.push({ key, def, matchedToken });
    }
  }

  if (matches.length === 0) return null;

  matches.sort((a, b) => b.matchedToken.length - a.matchedToken.length);
  return matches[0];
}

/**
 * Check whether a trigger family's synonyms appear in the inapplicability_reason.
 */
export function reasonMatchesFamily(reason, family) {
  const lower = canonicalize(reason);
  return (family.trigger_family || []).some(s => lower.includes(canonicalize(s)));
}

/**
 * Check whether the reason both references the same family and includes
 * a family-appropriate negation marker when required.
 */
export function reasonSupportsFamily(reason, family) {
  const lower = canonicalize(reason);
  const hasFamilyToken = reasonMatchesFamily(reason, family);
  if (!hasFamilyToken) return false;

  if (!family.negation_required) return true;

  const markers = (family.negation_markers || DEFAULT_NEGATION_MARKERS).map(canonicalize);
  return markers.some(m => lower.includes(m));
}


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
  'residential',
  'php',
  'iop',
  'op',
  'detox',
  'inpatient',
  'mh_rtf',
  'day/night',
  'day treatment',
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
      const idx = lower.indexOf(term);
      if (idx === -1) return false;

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
