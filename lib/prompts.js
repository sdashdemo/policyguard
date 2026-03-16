// lib/prompts.js — LLM prompts for obligation extraction, policy indexing, assessment, and rewrite

import { renderFacilityContext } from './facility-attributes.js';

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
// NOTE: The active extraction prompt lives inline in app/api/v6/extract/route.js
// It was moved there because it needs source metadata (name, type, citation_root) not facility profiles.

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

// ── COVERAGE ASSESSMENT PROMPT (v8: functional compliance + COVERED overcall guard) ──

export const ASSESS_PROMPT = (obligation, candidatePolicies, facility) => {
  // Build LOC applicability line
  const locLine = obligation.loc_applicability
    ? (Array.isArray(obligation.loc_applicability) ? obligation.loc_applicability.join(', ') : obligation.loc_applicability)
    : 'Not tagged — use citation context';

  // Build facility context block from dynamic attribute registry
  const facilityBlock = renderFacilityContext(facility);

  // Build candidate policies with numbered provisions
  const candidateBlock = candidatePolicies.map(cp => `
--- POLICY "${cp.policy_number}" — ${cp.title} ---
${cp.provisions.map((p, i) => `  [${i + 1}] (${p.section || 'General'}) ${p.text}`).join('\n')}
`).join('\n');

  return `You are a regulatory compliance assessor for a behavioral health organization.
Determine whether the following regulatory obligation is covered by any of the
candidate policies, following the decision procedure below EXACTLY.
${facilityBlock}

═══════════════════════════════════════════════════════
OBLIGATION
═══════════════════════════════════════════════════════
Citation: ${obligation.citation}
Requirement: ${obligation.requirement}
Regulation Source: ${obligation.source_name || 'Not specified'}
LOC Applicability: ${locLine}
Risk Tier: ${obligation.risk_tier || 'unclassified'}

═══════════════════════════════════════════════════════
CANDIDATE POLICIES AND PROVISIONS
═══════════════════════════════════════════════════════
${candidateBlock}

═══════════════════════════════════════════════════════
DECISION PROCEDURE (follow in this exact order)
═══════════════════════════════════════════════════════

STEP 1 — APPLICABILITY CHECK
Does this obligation apply to this facility?

An obligation does NOT apply when ALL THREE of the following are true:
  (a) The obligation is conditional on a specific activity, program, or level
      of care (e.g., "if the organization uses restraint," "for OTP programs,"
      "in buildings where smoking is permitted," or the obligation's citation
      or LOC Applicability field limits it to a LOC the facility does not offer)
  (b) The facility does not perform that activity, operate that program,
      or offer that LOC — as evidenced by the FACILITY CONTEXT above
      or by an explicit prohibition in one of the candidate policies
  (c) You can produce BOTH:
      - trigger_span: the conditional or scope-limiting phrase (quoted from
        Requirement, Citation, or LOC Applicability line)
      - inapplicability_reason: the specific facility attribute or policy
        provision proving the condition does not apply (quoted from the
        FACILITY CONTEXT block or a numbered provision above)

If (a), (b), and (c) are ALL met → status is NOT_APPLICABLE.
If ANY of (a), (b), or (c) is not met → the obligation APPLIES. Proceed to Step 2.

NOT_APPLICABLE is ONLY for obligations conditional on a specific practice,
program, or LOC. It is NOT for administrative or accreditation-process
obligations. When in doubt, the obligation APPLIES.

STEP 2 — COVERAGE ASSESSMENT
Review EVERY numbered provision from EVERY candidate policy above. Do not stop after finding the first relevant provision — scan all provisions before reaching your conclusion.

FUNCTIONAL-COMPLIANCE PRINCIPLE:
Do NOT require the policy to repeat the regulation's wording, citation structure, or chapter terminology.
A policy can satisfy an obligation when the quoted provisions, read in context and together if necessary, impose the same operational requirement on the same actor, in the same scope, with equivalent practical effect.

Concrete operational language counts even when the policy uses different words than the regulation.
Examples of concrete operational language include: required steps, mandatory reviews, required contents, documentation rules, approval rules, monitoring rules, time-bound actions, escalation rules, and explicit prohibitions.

General subject-matter similarity does NOT count.
Mission statements, broad policy goals, aspirational language, vague references to safety, quality, or compliance, or text that addresses only the same topic at a high level do NOT establish coverage.

You may rely on multiple provisions together ONLY when:
(1) each provision is concretely relevant,
(2) they address the same obligation,
(3) together they satisfy all material elements,
and
(4) you are not stitching together unrelated fragments from different policies to manufacture coverage.

COVERED =
The presented provisions, taken together if necessary, establish the same operational rule as the obligation and satisfy every material element that matters to compliance.
Material elements include, as applicable: actor, required action, trigger or condition, scope or population, timing or frequency, required documentation or content, approval or escalation path, and prohibition or limitation.
Do NOT mark COVERED if any material element is missing, broader, weaker, discretionary, optional, or assigned to the wrong actor or scope.

COVERED OVERCALL GUARD:
Do NOT mark COVERED merely because:
- the policy addresses the same general topic;
- the policy is directionally similar;
- the timeframe is broader or less strict;
- the policy applies in only one subset of situations while the obligation is broader;
- the policy states a principle without an enforceable operational requirement;
- the policy requires something related but not the specific duty at issue.

PARTIAL =
At least one concrete provision addresses the obligation's core duty, but one or more material elements are missing, weaker, broader, discretionary, or limited to a narrower actor, scope, or condition.
You MUST list exactly which material elements are missing or weaker in gap_detail.

GAP =
No presented provision provides concrete coverage of the obligation's core duty.
Use GAP only when the candidate policies do not operationally address the requirement at all.
If the evidence addresses the same duty but incompletely, approximately, or under a narrower or broader condition, the status is PARTIAL — not GAP.
If the evidence takes the opposite approach under the same conditions and scope, the status is CONFLICTING — not GAP.

For COVERED, PARTIAL, or GAP: you must list in reviewed_provision_refs every provision you considered relevant (minimum 2 unless fewer than 2 provisions exist across all candidates).

STEP 3 — CONFLICT CHECK (only if obligation APPLIES from Step 1)
  CONFLICTING = The obligation applies to this facility AND a policy
    provision affirmatively requires, permits, or mandates the OPPOSITE
    of what the regulation requires, under the SAME conditions and scope.

  A policy that PROHIBITS an activity governed by a conditional obligation
  is NOT a conflict — return to Step 1 and assess as NOT_APPLICABLE.
  Only mark CONFLICTING when the policy and regulation directly contradict
  each other on an obligation that applies.

═══════════════════════════════════════════════════════
RESPONSE FORMAT
═══════════════════════════════════════════════════════

Return a single JSON object. No markdown fences, no other text.

{
  "status": "COVERED | PARTIAL | GAP | CONFLICTING | NOT_APPLICABLE",
  "confidence": "high | medium | low",
  "covering_policy_number": "Exact policy number from candidates, or null if GAP/NOT_APPLICABLE",
  "obligation_span": "Key phrase from Requirement establishing this requirement (max 200 chars, must be exact substring of Requirement). Required for COVERED/PARTIAL/CONFLICTING. Null for GAP/NOT_APPLICABLE.",
  "provision_span": "Policy text that addresses or contradicts this obligation (max 200 chars, must be exact substring of a numbered provision above). Required for COVERED/PARTIAL/CONFLICTING. Null for GAP/NOT_APPLICABLE.",
  "gap_detail": "What specific elements are missing, listed individually. Required for PARTIAL and GAP. Null for COVERED/NOT_APPLICABLE.",
  "recommended_policy": "For GAP/PARTIAL: which existing policy number should address this. Null for COVERED/CONFLICTING/NOT_APPLICABLE.",
  "reasoning": "2-3 sentences explaining your assessment. Reference specific provisions as PolicyNumber[N] (e.g. CL6.005[3]).",
  "reviewed_provision_refs": ["CL6.005[3]", "CL6.007[1]"],
  "trigger_span": "For NOT_APPLICABLE only: the conditional or scope-limiting phrase (must be exact substring of Requirement OR Citation OR LOC Applicability line). Null for all other statuses.",
  "inapplicability_reason": "For NOT_APPLICABLE only: the specific facility attribute or policy statement proving the condition does not apply (must be exact substring of the FACILITY CONTEXT block or a numbered provision above). Null for all other statuses.",
  "conflict_detail": "For CONFLICTING only: quote BOTH the obligation phrase AND the contradicting policy phrase, and explain why both apply under the same conditions. Null for all other statuses."
}

FIELD RULES:
- obligation_span must be an EXACT SUBSTRING of the Requirement text above.
- provision_span must be an EXACT SUBSTRING of a numbered provision above.
- trigger_span must be an EXACT SUBSTRING of the Requirement, Citation, or LOC Applicability line.
- inapplicability_reason must be an EXACT SUBSTRING of the FACILITY CONTEXT block or a numbered provision. It may NOT be any of: "Not specified", "None specified", "No", "YES", or any single-word value from the facility context.
- For NOT_APPLICABLE: both trigger_span and inapplicability_reason are REQUIRED. The inapplicability_reason must be topically related to the trigger (e.g., if the trigger concerns restraint, the evidence must reference restraint or physical interventions). If you cannot produce valid anchored evidence for both, the obligation APPLIES — reassess as COVERED/PARTIAL/GAP.
- For CONFLICTING: conflict_detail is REQUIRED and must include quoted text from both the obligation and the contradicting provision, with an explanation of why both apply under the same conditions and scope.
- For PARTIAL: gap_detail is REQUIRED and must enumerate specific missing elements.
- covering_policy_number must exactly match a policy number from the candidates above.
- reviewed_provision_refs must list at least 2 provision references for COVERED/PARTIAL/CONFLICTING (unless fewer than 2 total provisions exist across all candidates). Format: "PolicyNumber[ProvisionIndex]".
- Do not fabricate policy numbers, provision text, or facility attributes.

Return ONLY the JSON object.`;
};

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
