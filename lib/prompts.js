// lib/prompts.js — LLM prompts for obligation extraction, policy indexing, assessment, and rewrite

export const DOMAIN_LIST = [
  { id: 'clinical', label: 'Clinical', prefix: 'CL', tjc: 'CTS, PC, RI' },
  { id: 'medical', label: 'Medical', prefix: 'MED', tjc: 'CTS, PC' },
  { id: 'nursing', label: 'Nursing', prefix: 'NUR', tjc: 'CTS, PC' },
  { id: 'pharmacy', label: 'Pharmacy', prefix: 'MMP', tjc: 'MM' },
  { id: 'lab', label: 'Lab', prefix: 'LAB', tjc: 'WT' },
  { id: 'infection_control', label: 'Infection Control', prefix: 'IC', tjc: 'IC' },
  { id: 'environment_of_care', label: 'Environment of Care', prefix: 'EC', tjc: 'EC' },
  { id: 'emergency_management', label: 'Emergency Management', prefix: 'EM', tjc: 'EM' },
  { id: 'life_safety', label: 'Life Safety', prefix: 'LS', tjc: 'LS' },
  { id: 'utilization_review', label: 'Utilization Review', prefix: 'UR', tjc: '' },
  { id: 'leadership', label: 'Leadership', prefix: 'LD', tjc: 'LD' },
  { id: 'performance_improvement', label: 'Performance Improvement', prefix: 'PI', tjc: 'PI' },
  { id: 'plans', label: 'Plans', prefix: '', tjc: 'spans multiple' },
  { id: 'human_resources', label: 'Human Resources', prefix: 'HR', tjc: 'HRM' },
  { id: 'information_management', label: 'Information Management', prefix: 'IM', tjc: 'IM, RC' },
  { id: 'financial', label: 'Financial', prefix: 'FIN', tjc: '' },
  { id: 'corporate', label: 'Corporate', prefix: '', tjc: '' },
  { id: 'it_cybersecurity', label: 'IT / Cybersecurity', prefix: 'IT', tjc: '' },
  { id: 'compliance', label: 'Compliance', prefix: '', tjc: '' },
  { id: 'legal', label: 'Legal', prefix: '', tjc: '' },
  { id: 'rcm', label: 'Revenue Cycle Management', prefix: 'RCM', tjc: '' },
  { id: 'admissions', label: 'Admissions', prefix: '', tjc: '' },
  { id: 'business_development', label: 'Business Development', prefix: 'BD', tjc: '' },
];

// ── OBLIGATION EXTRACTION PROMPT ──

export const EXTRACT_PROMPT = (domain, sourceName, chunkText, facilityProfile) => {
  let exclusions = '';
  if (facilityProfile) {
    const excluded = [];
    if (!facilityProfile.servicesOffered?.includes('methadone')) {
      excluded.push('methadone-specific OTP requirements (buprenorphine MAT requirements ARE applicable)');
    }
    if (!facilityProfile.servicesOffered?.includes('juvenile')) {
      excluded.push('juvenile justice services requirements');
    }
    if (!facilityProfile.servicesOffered?.includes('children')) {
      excluded.push('child welfare or pediatric-specific requirements');
    }
    if (facilityProfile.prohibitsRestraint) {
      excluded.push('detailed restraint/seclusion procedure requirements (extract ONLY the requirement that facilities must have a policy on whether they use or prohibit these interventions)');
    }
    if (!facilityProfile.servicesOffered?.includes('prevention')) {
      excluded.push('prevention services requirements');
    }
    if (excluded.length > 0) {
      exclusions = `\n\nEXCLUDE these requirement categories (not applicable to this facility):\n${excluded.map(e => `- ${e}`).join('\n')}`;
    }
  }

  const domainInstruction = domain === 'all'
    ? `\nExtract ALL operational requirements from this source across all domains. Tag each with the appropriate topic.`
    : `\nFOCUS: Only extract requirements relevant to the "${domain}" policy domain.`;

  return `You are a regulatory compliance expert for behavioral health organizations. Extract requirements from this regulatory/standards source.

SOURCE: ${sourceName}
${domainInstruction}${exclusions}

TEXT:
${chunkText}

INSTRUCTIONS:
- Extract each distinct obligation, standard, or requirement as a separate item.
- For TJC: each Element of Performance (EP) is typically one requirement.
- For state regulations: each subsection with a distinct obligation is one requirement.
- CONSOLIDATE related items: if a regulation lists sub-items that are all part of the same requirement (e.g., "the record shall contain: A) assessments, B) plans, C) notes..."), extract as ONE requirement describing the complete obligation.
- Skip requirements purely administrative to the licensing agency (application forms, fee schedules, renewal procedures).
- Include the specific text span from the source that contains this requirement (for citation anchoring).

Return a JSON object (no other text, no markdown fences):

{
  "requirements": [
    {
      "id": "R1",
      "source_type": "state_reg or tjc or federal or guidelines",
      "citation": "Specific citation (e.g., 65D-30.004(6)(a), PC.01.02.01 EP1)",
      "requirement": "Clear statement of the operational obligation",
      "source_span": "The exact text from the regulation that establishes this requirement (verbatim, max 300 chars)",
      "topic": "One of: assessment, treatment_planning, documentation, medical_director, medication_management, infection_control, patient_rights, consent, discharge, case_management, counseling, supervision, emergency_management, incident_reporting, overdose_prevention, telehealth, drug_screening, patient_education, staffing, medical_protocols, quality_improvement, environment_of_care, information_management, other",
      "responsible_party": "Who must comply (e.g., provider, physician, clinical director, nursing staff)",
      "timeframe": "Any deadline or frequency (e.g., within 24 hours, annually, upon admission), or null",
      "documentation": "What must be documented, or null"
    }
  ]
}

Return ONLY the JSON object.`;
};


// ── POLICY INDEXING PROMPT ──

export const INDEX_PROMPT = (filename, fullText) => {
  const allDomains = DOMAIN_LIST.map(d => d.id);

  return `Analyze this behavioral health policy document and extract structured metadata.

FILENAME: ${filename}

FULL POLICY TEXT:
${fullText}

DOMAIN CLASSIFICATION — assign ONE of these domains based on the policy's primary subject matter and prefix:
${allDomains.join(', ')}

DOMAIN HINTS BY PREFIX:
- CL → clinical | MED → medical | NUR → nursing | MMP → pharmacy | LAB → lab
- IC → infection_control | EC → environment_of_care | EM → emergency_management | LS → life_safety
- LD → leadership | PI → performance_improvement | HR → human_resources | IM → information_management
- FIN → financial | UR → utilization_review | Plans (no prefix) → plans

Return a JSON object with EXACTLY this structure (no other text, no markdown fences):

{
  "policy_id": "The policy ID from the header (e.g., CL-1.004, MED 2.016a, MMP3.001)",
  "title": "The policy title from the header",
  "domain": "One of the domains listed above",
  "facility_name": "The facility name in the SCOPE section",
  "effective_date": "From header",
  "revision_dates": "From header",
  "dcf_citations": ["List of DCF/65D-30 citations from header, exactly as written"],
  "tjc_citations": ["List of JCAHO/TJC citations from header, exactly as written"],
  "purpose": "The PURPOSE section text, verbatim",
  "summary": "One sentence describing what this policy actually covers based on the full text",
  "section_headings": ["List of all section/procedure headings in order"],
  "provisions": [
    {
      "text": "Exact verbatim text of each shall/must/will/required obligation or rule. Copy word-for-word.",
      "section": "Which section this appears in",
      "source": "If the provision cites a specific regulation or standard, note it here. Otherwise null."
    }
  ],
  "topics_covered": ["List of compliance topics this policy addresses"],
  "header_issues": ["List any apparent problems: wrong citations, missing TJC references, inconsistent facility names, etc."]
}

CRITICAL: Extract EVERY sentence containing "shall", "must", "will", "required", or stating a rule/obligation. Copy EXACT wording. Return ONLY the JSON object.`;
};


// ── COVERAGE ASSESSMENT PROMPT (v6: citation anchoring + expanded statuses) ──

export const ASSESS_PROMPT = (obligation, candidatePolicies) => `You are a regulatory compliance expert for behavioral health organizations. Determine whether the following regulatory obligation is covered by any of the candidate policies.

OBLIGATION:
Citation: ${obligation.citation}
Requirement: ${obligation.requirement}

CANDIDATE POLICIES AND THEIR PROVISIONS:
${candidatePolicies.map(cp => `
--- POLICY "${cp.policy_number}" — ${cp.title} ---
${cp.provisions.map(p => `• [${p.section || 'General'}] ${p.text}`).join('\n')}
`).join('\n')}

ASSESSMENT RULES:
- COVERED = a provision fully addresses every element: actor, action, condition, timeframe, documentation requirement.
- PARTIAL = the topic is addressed but specific elements are missing (explain exactly what's missing).
- GAP = no policy meaningfully addresses this requirement.
- CONFLICTING = a policy provision appears to contradict the regulatory requirement.
- Be STRICT. Vague references don't count. The provision must actually require what the obligation requires.
- If multiple policies partially cover it, pick the BEST one and note the gap.

CITATION ANCHORING (required):
- For the obligation: quote the key regulatory phrase that establishes the requirement (max 200 chars).
- For the matching provision: quote the specific policy text that addresses it (max 200 chars).

Return a JSON object (no other text, no markdown fences):

{
  "status": "COVERED or PARTIAL or GAP or CONFLICTING",
  "confidence": "high or medium or low",
  "covering_policy_number": "The exact policy number (e.g. CL2.004, MED-2.002), or null if GAP",
  "obligation_span": "Key phrase from the regulation establishing this requirement",
  "provision_span": "Specific policy text that addresses this obligation, or null",
  "gap_detail": "What is missing or needs adding. Null if fully COVERED.",
  "recommended_policy": "For GAP/PARTIAL: which policy number should address this. Null if COVERED.",
  "reasoning": "Brief explanation of your assessment"
}

Return ONLY the JSON object.`;


// ── POLICY REWRITE PROMPT ──

export const REWRITE_PROMPT = (policyId, policyTitle, policyFullText, domain, regulationText, assignedRequirements, siblingCoverage) => `You are PolicyGuard, rewriting a behavioral health policy for dual compliance with state regulations and TJC standards.

POLICY: ${policyId} — ${policyTitle}
DOMAIN: ${domain}

FULL CURRENT POLICY TEXT:
${policyFullText}

REGULATION AND STANDARDS TEXT:
${regulationText}

REQUIREMENTS ASSIGNED TO THIS POLICY:
${assignedRequirements}

REQUIREMENTS COVERED BY SIBLING POLICIES (cross-reference only):
${siblingCoverage}

Complete these steps:

## STEP 1: SCOPE CLASSIFICATION
Confirm domain, TJC chapters, what this policy covers vs. siblings, header corrections needed.

## STEP 2: REQUIREMENT ANALYSIS
For each assigned requirement: COMPLIANT, PARTIAL, MISSING, or WEAKER.

## STEP 3: GAP ANALYSIS TABLE
| # | Requirement | State Reg | TJC Standard | Gap Type | Planned Change |

## STEP 4: REWRITTEN POLICY
NON-NEGOTIABLE RULES:
1. NEVER WEAKEN existing standards
2. STAY IN SCOPE — only requirements assigned to this policy
3. PRESERVE STRUCTURE — keep existing sections and headings
4. PROTECT HEADER — only update regulation/standard fields
5. "Program Director"/"Executive Director" → "Site-CEO" in body text
6. DUAL CITATION when a provision satisfies both: [65D-30.0043(4)(a); TJC CTS.06.02.03 EP 3]
7. STRICTER PREVAILS
8. NO DUPLICATION — sibling-covered items get one cross-reference sentence only

Mark changes: [NEW — Citation(s)] | [MODIFIED — Citation(s)] | [CROSS-REF — Policy ID]

Output the COMPLETE rewritten policy text.

## STEP 5: CHANGE LOG AND VALIDATION
A. Change Log Table: | # | State Reg | TJC Standard | Change Type | Section | What Changed | Stricter Source |
B. Coverage Matrix: | TJC Standard | State Reg Equivalent | Policy Section | Status |
C. Self-Validation Checklist (scope, strictness, dual compliance, no duplication, structure, header, attribution)
D. TJC Survey Readiness Notes`;
