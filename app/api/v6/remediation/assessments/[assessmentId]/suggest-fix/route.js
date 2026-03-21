import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { getAssessmentDetail } from '@/lib/remediation';
import { MODEL_ID } from '@/lib/audit';
import { parseJSON } from '@/lib/parse';
import { assessmentFixSuggestions, policyHealthChecks } from '@/lib/schema';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const POLICY_HEALTH_PROMPT_VERSION = 'policy_health_v1';
const SUGGEST_FIX_PROMPT_VERSION = 'suggest_fix_v1';

function normalizeString(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function truncateText(value, maxLength) {
  const normalized = normalizeString(value);
  if (!normalized) return null;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength)}...`
    : normalized;
}

function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return false;
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }

  const normalized = normalizeString(value);
  if (!normalized) return [];

  if (!/\r?\n/.test(normalized)) {
    return [normalized];
  }

  return normalized
    .split(/\r?\n+/)
    .map((line) => normalizeString(line.replace(/^[-*]\s*/, '')))
    .filter(Boolean);
}

function normalizeImplementationNotes(value) {
  return normalizeStringList(value);
}

function implementationNotesToText(notes) {
  return Array.isArray(notes) && notes.length
    ? notes.join('\n')
    : null;
}

function normalizePolicyHealthSeverity(value) {
  const normalized = normalizeString(value)?.toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizePolicyHealthType(value, flags = {}) {
  const normalized = normalizeString(value)
    ?.toLowerCase()
    .replace(/\s+/g, '_');

  if (normalized) return normalized;
  if (flags.staleCitation) return 'stale_citation';
  if (flags.abbreviationDiscipline) return 'abbreviation_discipline';
  if (flags.definedTermDiscipline) return 'defined_term_discipline';
  return 'general_gap';
}

function normalizePolicyHealthFinding(value) {
  if (typeof value === 'string') {
    const issue = normalizeString(value);
    if (!issue) return null;

    return {
      severity: 'medium',
      type: 'general_gap',
      issue,
      suggestedInsertionPoint: null,
      staleCitation: false,
      abbreviationDiscipline: false,
      definedTermDiscipline: false,
    };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const issue = normalizeString(value.issue)
    || normalizeString(value.description)
    || normalizeString(value.summary);

  if (!issue) return null;

  const staleCitation = normalizeBoolean(value.staleCitation);
  const abbreviationDiscipline = normalizeBoolean(value.abbreviationDiscipline);
  const definedTermDiscipline = normalizeBoolean(value.definedTermDiscipline);

  return {
    severity: normalizePolicyHealthSeverity(value.severity),
    type: normalizePolicyHealthType(value.type, {
      staleCitation,
      abbreviationDiscipline,
      definedTermDiscipline,
    }),
    issue,
    suggestedInsertionPoint: normalizeString(value.suggestedInsertionPoint)
      || normalizeString(value.insertionPoint)
      || normalizeString(value.location),
    staleCitation,
    abbreviationDiscipline,
    definedTermDiscipline,
  };
}

function normalizePolicyHealthFindings(value) {
  const rawFindings = Array.isArray(value?.findings)
    ? value.findings
    : (Array.isArray(value?.issues)
      ? value.issues
      : (Array.isArray(value) ? value : []));

  return rawFindings
    .map((finding) => normalizePolicyHealthFinding(finding))
    .filter(Boolean)
    .slice(0, 5);
}

function buildPolicyHealthIssues(findings = []) {
  return findings
    .map((finding) => normalizeString(finding?.issue))
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeSuggestedFix(rawSuggestedFix, fallbackDraftLanguage) {
  const structured = rawSuggestedFix && typeof rawSuggestedFix === 'object' && !Array.isArray(rawSuggestedFix)
    ? rawSuggestedFix
    : null;
  const rawSuggestedFixText = structured ? null : normalizeString(rawSuggestedFix);

  const draftLanguage = normalizeString(structured?.draftLanguage)
    || normalizeString(structured?.draft)
    || normalizeString(structured?.text)
    || rawSuggestedFixText
    || fallbackDraftLanguage;

  return {
    draftLanguage,
    implementationNotes: normalizeImplementationNotes(
      structured?.implementationNotes
      ?? structured?.notes,
    ),
  };
}

function toJsonTimestamp(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isNaN(date.getTime())) {
    return date.toISOString();
  }

  return normalizeString(value);
}

function buildProvisionsBlock(provisions = []) {
  if (!Array.isArray(provisions) || provisions.length === 0) {
    return 'No matched policy provisions were available.';
  }

  return provisions
    .slice(0, 12)
    .map((provision, index) => [
      `Provision ${index + 1}`,
      provision.section ? `Section: ${provision.section}` : null,
      provision.sourceCitation ? `Source Citation: ${provision.sourceCitation}` : null,
      `Text: ${truncateText(provision.text, 1400) || 'Not available'}`,
    ].filter(Boolean).join('\n'))
    .join('\n\n');
}

function buildCachedPolicyHealthBlock(policyHealthCheck) {
  if (!policyHealthCheck) return '';

  const findings = normalizePolicyHealthFindings(policyHealthCheck);
  return [
    'CACHED POLICY HEALTH',
    `Summary: ${policyHealthCheck.summary || 'Matched policy review was unavailable.'}`,
    findings.length
      ? `Findings:\n${findings.map((finding) => [
        `- [${finding.severity}] ${finding.issue}`,
        finding.suggestedInsertionPoint ? `  Suggested insertion point: ${finding.suggestedInsertionPoint}` : null,
        finding.staleCitation ? '  Flag: stale citation' : null,
        finding.abbreviationDiscipline ? '  Flag: abbreviation discipline' : null,
        finding.definedTermDiscipline ? '  Flag: defined-term discipline' : null,
      ].filter(Boolean).join('\n')).join('\n')}`
      : 'Findings: None recorded.',
  ].join('\n');
}

function buildSuggestFixPrompt(detail, options = {}) {
  const assessment = detail.assessment;
  const obligation = detail.obligation;
  const policy = detail.policy;
  const provisions = detail.provisions || [];
  const includePolicyHealth = options.includePolicyHealth === true && Boolean(policy);
  const cachedPolicyHealthBlock = buildCachedPolicyHealthBlock(options.cachedPolicyHealth || null);
  const noMatchedPolicyInstruction = !policy
    ? 'When no matched policy exists, draft the narrowest reviewer-usable provision language that directly addresses the specific cited regulatory requirement rather than writing a broad compliance policy. Anchor each sentence to a concrete obligation from the cited regulation. Do not include generic compliance boilerplate (for example, annual review, designated compliance officer, public posting, or reporting workflows) unless the cited regulation specifically supports it. Avoid alarmist or rhetorical language. If helpful, separate required draft language from optional implementation notes. For no-matched-policy rows, draft only the minimum policy provision language needed to address the cited requirement. Keep the draft to 1-3 sentences unless the citation clearly requires more detail. Do not assign roles, owners, compliance officers, leadership notifications, monitoring steps, renewal calendars, reporting workflows, or escalation processes unless the cited regulation expressly supports them. Avoid evaluative phrases like "critical compliance gap" and state the deficiency neutrally.\n'
    : '';

  return `You are PolicyGuard, helping a remediation reviewer draft a practical policy fix.

You are reviewing one remediation item. Produce a concise, reviewer-usable suggestion that can help a human revise policy language or document a remediation step.

Return a single JSON object with EXACTLY this structure and no markdown fences:
{
  "summary": "2-4 sentences explaining why this fix is suggested.",
  "suggestedFix": {
    "draftLanguage": "Specific draft policy language or remediation guidance in plain text.",
    "implementationNotes": ["Short reviewer note", "Short reviewer note"]
  }${includePolicyHealth ? `,
  "policyHealth": {
    "summary": "1-3 sentences about how healthy or fragile the matched policy looks for this obligation.",
    "findings": [
      {
        "severity": "high",
        "type": "missing_requirement",
        "issue": "Short explanation of the problem.",
        "suggestedInsertionPoint": "Where to insert or revise language, if inferable.",
        "staleCitation": false,
        "abbreviationDiscipline": false,
        "definedTermDiscipline": false
      }
    ]
  }` : ''}
}

If there is no matched policy, still return a best-effort "summary" and "suggestedFix".${includePolicyHealth ? ' In that case set "policyHealth" to null.' : ''}

Guidance:
- Write for a compliance reviewer, not an engineer.
- Be concrete and operational.
- If the item is GAP, propose language or steps that would close the gap.
- If the item is PARTIAL, explain what is missing and draft the missing addition.
- If no matched policy exists, provide best-effort draft language or remediation guidance that could become a new policy section or interim corrective action.
- Put language a reviewer might copy into policy in the "suggestedFix.draftLanguage" field.
- Put optional reviewer guidance, rollout notes, or caveats in the "suggestedFix.implementationNotes" list. Use an empty array if no notes are needed.
- Do not mention JSON, prompts, or system internals.
- Do not recommend database changes, UI changes, or route changes.
- ${includePolicyHealth
    ? 'If a matched policy exists, include a concise policyHealth block based only on the matched policy and the cited obligation. Keep findings reviewer-usable, set severity to low/medium/high, and use the boolean flags only when the finding specifically involves stale citations, abbreviation discipline, or defined-term discipline.'
    : 'Do not return a policyHealth field in this response.'}

${cachedPolicyHealthBlock ? `Use the cached policy-health context below when it helps, but do not rewrite or contradict it unless the current assessment detail clearly requires a different remediation suggestion.\n\n${cachedPolicyHealthBlock}\n\n` : ''}${noMatchedPolicyInstruction}ASSESSMENT DETAIL
Assessment ID: ${assessment.id}
Assessment Status: ${assessment.status}
Confidence: ${assessment.confidence || 'unknown'}
Covering Policy Number: ${assessment.coveringPolicyNumber || 'none'}
Reasoning:
${truncateText(assessment.reasoning, 2500) || 'No reasoning available.'}

Gap Detail:
${truncateText(assessment.gapDetail, 2500) || 'No gap detail available.'}

OBLIGATION
Citation: ${obligation.citation || 'Unknown citation'}
Requirement:
${truncateText(obligation.requirement, 3000) || 'No requirement text available.'}
Risk Tier: ${obligation.riskTier || 'unknown'}
Topics: ${Array.isArray(obligation.topics) ? obligation.topics.join(', ') : (obligation.topics || 'none')}
Location Applicability: ${Array.isArray(obligation.locApplicability) ? obligation.locApplicability.join(', ') : (obligation.locApplicability || 'none')}

MATCHED POLICY
${policy ? `Policy Number: ${policy.policyNumber}
Title: ${policy.title || 'Untitled policy'}
Domain: ${policy.domain || 'unknown'}
Sub-domain: ${policy.subDomain || 'unknown'}` : 'No matched policy is available for this assessment.'}

MATCHED POLICY PROVISIONS
${buildProvisionsBlock(provisions)}

Return ONLY the JSON object.`;
}

function normalizePolicyHealth(rawPolicyHealth, hasMatchedPolicy) {
  if (!hasMatchedPolicy) {
    return null;
  }

  if (!rawPolicyHealth || typeof rawPolicyHealth !== 'object' || Array.isArray(rawPolicyHealth)) {
    return {
      summary: 'Matched policy review was unavailable.',
      findings: [],
      issues: [],
    };
  }

  const findings = normalizePolicyHealthFindings(rawPolicyHealth);
  return {
    summary: normalizeString(rawPolicyHealth.summary) || 'Matched policy review was unavailable.',
    findings,
    issues: buildPolicyHealthIssues(findings),
  };
}

function normalizeCachedPolicyHealth(policyHealthCheck, hasMatchedPolicy) {
  if (!hasMatchedPolicy || !policyHealthCheck) {
    return null;
  }

  const findings = normalizePolicyHealthFindings(policyHealthCheck);
  return {
    summary: normalizeString(policyHealthCheck.summary) || 'Matched policy review was unavailable.',
    findings,
    issues: buildPolicyHealthIssues(findings),
  };
}

function normalizeSuggestionPayload(detail, parsed, options = {}) {
  const hasMatchedPolicy = Boolean(detail.policy);
  const policyHealth = Object.prototype.hasOwnProperty.call(options, 'policyHealth')
    ? options.policyHealth
    : normalizePolicyHealth(parsed?.policyHealth, hasMatchedPolicy);
  const fallbackDraftLanguage = hasMatchedPolicy
    ? 'No draft policy language was returned.'
    : 'No matched policy was available. Draft a new policy section or corrective-action language that directly addresses the cited requirement.';
  const suggestedFix = Object.prototype.hasOwnProperty.call(options, 'suggestedFix')
    ? options.suggestedFix
    : normalizeSuggestedFix(parsed?.suggestedFix, fallbackDraftLanguage);
  const implementationNotes = normalizeImplementationNotes(
    Object.prototype.hasOwnProperty.call(options, 'implementationNotes')
      ? options.implementationNotes
      : (suggestedFix.implementationNotes?.length ? suggestedFix.implementationNotes : parsed?.implementationNotes),
  );
  const draftLanguage = normalizeString(suggestedFix?.draftLanguage) || fallbackDraftLanguage;

  return {
    ok: true,
    assessmentId: detail.assessment.id,
    summary: normalizeString(parsed?.summary)
      || (hasMatchedPolicy
        ? 'A matched policy was available, so the suggestion focuses on closing the identified coverage gap or weakness.'
        : 'No matched policy was available, so the suggestion provides best-effort remediation language and next-step guidance.'),
    suggestedFix: {
      draftLanguage,
      implementationNotes,
    },
    draftLanguage,
    implementationNotes,
    implementationNotesText: implementationNotesToText(implementationNotes),
    policyHealth,
    metadata: {
      hasMatchedPolicy,
      policyNumber: detail.policy?.policyNumber || null,
      policyHealthSource: options.policyHealthSource || (hasMatchedPolicy ? 'generated' : 'not_applicable'),
      policyHealthGeneratedAt: options.policyHealthGeneratedAt || null,
      policyHealthPromptVersion: options.policyHealthPromptVersion || null,
      policyHealthCheckId: options.policyHealthCheckId || null,
      suggestionId: options.suggestionId || null,
      suggestionGeneratedAt: options.suggestionGeneratedAt || null,
      suggestionPromptVersion: options.suggestionPromptVersion || null,
      suggestionSource: options.suggestionSource || null,
    },
  };
}

function parseRefreshPolicyHealth(body) {
  return Boolean(body && typeof body === 'object' && body.refreshPolicyHealth === true);
}

function buildPolicyHealthContextHash(detail) {
  if (!detail.policy) return null;

  const payload = {
    assessment: {
      id: detail.assessment?.id || null,
      status: detail.assessment?.status || null,
      confidence: detail.assessment?.confidence || null,
      reasoning: normalizeString(detail.assessment?.reasoning),
      gapDetail: normalizeString(detail.assessment?.gapDetail),
    },
    obligation: {
      id: detail.obligation?.id || null,
      citation: detail.obligation?.citation || null,
      requirement: detail.obligation?.requirement || null,
      riskTier: detail.obligation?.riskTier || null,
      topics: Array.isArray(detail.obligation?.topics) ? detail.obligation.topics : detail.obligation?.topics || null,
      locApplicability: Array.isArray(detail.obligation?.locApplicability)
        ? detail.obligation.locApplicability
        : detail.obligation?.locApplicability || null,
    },
    policy: {
      id: detail.policy?.id || null,
      policyNumber: detail.policy?.policyNumber || null,
      title: detail.policy?.title || null,
      domain: detail.policy?.domain || null,
      subDomain: detail.policy?.subDomain || null,
    },
    provisions: Array.isArray(detail.provisions)
      ? detail.provisions.map((provision) => ({
        id: provision.id || null,
        section: normalizeString(provision.section),
        sourceCitation: normalizeString(provision.sourceCitation),
        text: normalizeString(provision.text),
      }))
      : [],
  };

  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function canUseCachedPolicyHealth(detail, contextHash, refreshPolicyHealth) {
  const policyHealthCheck = detail.policyHealthCheck;
  return Boolean(
    detail.policy
    && policyHealthCheck
    && !refreshPolicyHealth
    && policyHealthCheck.policyId === detail.policy.id
    && policyHealthCheck.promptVersion === POLICY_HEALTH_PROMPT_VERSION
    && policyHealthCheck.contextHash
    && policyHealthCheck.contextHash === contextHash,
  );
}

function normalizeStoredPolicyHealthCheck(row) {
  if (!row) return null;

  const findings = normalizePolicyHealthFindings(row.findingsJson);

  return {
    id: row.id,
    assessmentId: row.assessmentId,
    policyId: row.policyId,
    summary: normalizeString(row.summary) || 'Matched policy review was unavailable.',
    findings,
    issues: buildPolicyHealthIssues(findings),
    promptVersion: normalizeString(row.promptVersion),
    modelId: normalizeString(row.modelId),
    contextHash: normalizeString(row.contextHash),
    generatedAt: row.generatedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function normalizeStoredAssessmentFixSuggestion(row) {
  if (!row) return null;

  return {
    id: row.id,
    assessmentId: row.assessmentId,
    policyHealthCheckId: row.policyHealthCheckId || null,
    implementationNotes: normalizeImplementationNotes(row.implementationNotes),
    implementationNotesText: implementationNotesToText(normalizeImplementationNotes(row.implementationNotes)),
    promptVersion: normalizeString(row.promptVersion),
    generatedAt: row.generatedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
  };
}

function buildStoredSuggestionJson(payload) {
  const findings = normalizePolicyHealthFindings(payload.policyHealth);
  return {
    summary: payload.summary,
    suggestedFix: {
      draftLanguage: payload.suggestedFix?.draftLanguage || payload.draftLanguage || null,
      implementationNotes: payload.implementationNotes || [],
    },
    implementationNotes: payload.implementationNotes || [],
    policyHealth: payload.policyHealth
      ? {
        summary: payload.policyHealth.summary,
        findings,
        issues: buildPolicyHealthIssues(findings),
      }
      : null,
    metadata: {
      hasMatchedPolicy: payload.metadata?.hasMatchedPolicy === true,
      policyNumber: payload.metadata?.policyNumber || null,
      policyHealthSource: payload.metadata?.policyHealthSource || null,
      policyHealthGeneratedAt: toJsonTimestamp(payload.metadata?.policyHealthGeneratedAt),
      policyHealthPromptVersion: payload.metadata?.policyHealthPromptVersion || null,
      policyHealthCheckId: payload.metadata?.policyHealthCheckId || null,
    },
  };
}

async function upsertPolicyHealthCheck(detail, policyHealth, contextHash) {
  if (!detail.assessment?.id || !detail.policy?.id || !policyHealth) {
    return null;
  }

  const now = new Date();
  const findings = normalizePolicyHealthFindings(policyHealth);
  const findingsJson = {
    findings,
    issues: buildPolicyHealthIssues(findings),
  };

  const [row] = await db
    .insert(policyHealthChecks)
    .values({
      assessment_id: detail.assessment.id,
      policy_id: detail.policy.id,
      summary: policyHealth.summary,
      findings_json: findingsJson,
      prompt_version: POLICY_HEALTH_PROMPT_VERSION,
      model_id: MODEL_ID,
      context_hash: contextHash,
      generated_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: policyHealthChecks.assessment_id,
      set: {
        policy_id: detail.policy.id,
        summary: policyHealth.summary,
        findings_json: findingsJson,
        prompt_version: POLICY_HEALTH_PROMPT_VERSION,
        model_id: MODEL_ID,
        context_hash: contextHash,
        generated_at: now,
        updated_at: now,
      },
    })
    .returning({
      id: policyHealthChecks.id,
      assessmentId: policyHealthChecks.assessment_id,
      policyId: policyHealthChecks.policy_id,
      summary: policyHealthChecks.summary,
      findingsJson: policyHealthChecks.findings_json,
      promptVersion: policyHealthChecks.prompt_version,
      modelId: policyHealthChecks.model_id,
      contextHash: policyHealthChecks.context_hash,
      generatedAt: policyHealthChecks.generated_at,
      createdAt: policyHealthChecks.created_at,
      updatedAt: policyHealthChecks.updated_at,
    });

  return normalizeStoredPolicyHealthCheck(row);
}

async function upsertAssessmentFixSuggestion(detail, suggestionPayload, policyHealthCheckId) {
  if (!detail.assessment?.id || !suggestionPayload) {
    return null;
  }

  const now = new Date();

  const [row] = await db
    .insert(assessmentFixSuggestions)
    .values({
      assessment_id: detail.assessment.id,
      policy_health_check_id: policyHealthCheckId || null,
      summary: suggestionPayload.summary,
      suggested_fix: suggestionPayload.suggestedFix?.draftLanguage || suggestionPayload.draftLanguage,
      implementation_notes: suggestionPayload.implementationNotesText || null,
      raw_response_json: buildStoredSuggestionJson(suggestionPayload),
      prompt_version: SUGGEST_FIX_PROMPT_VERSION,
      model_id: MODEL_ID,
      generated_at: now,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: assessmentFixSuggestions.assessment_id,
      set: {
        policy_health_check_id: policyHealthCheckId || null,
        summary: suggestionPayload.summary,
        suggested_fix: suggestionPayload.suggestedFix?.draftLanguage || suggestionPayload.draftLanguage,
        implementation_notes: suggestionPayload.implementationNotesText || null,
        raw_response_json: buildStoredSuggestionJson(suggestionPayload),
        prompt_version: SUGGEST_FIX_PROMPT_VERSION,
        model_id: MODEL_ID,
        generated_at: now,
        updated_at: now,
      },
    })
    .returning({
      id: assessmentFixSuggestions.id,
      assessmentId: assessmentFixSuggestions.assessment_id,
      policyHealthCheckId: assessmentFixSuggestions.policy_health_check_id,
      implementationNotes: assessmentFixSuggestions.implementation_notes,
      promptVersion: assessmentFixSuggestions.prompt_version,
      generatedAt: assessmentFixSuggestions.generated_at,
      createdAt: assessmentFixSuggestions.created_at,
      updatedAt: assessmentFixSuggestions.updated_at,
    });

  return normalizeStoredAssessmentFixSuggestion(row);
}

export async function POST(req, { params }) {
  try {
    const assessmentId = normalizeString(params?.assessmentId);
    if (!assessmentId) {
      return Response.json({ error: 'Missing assessmentId' }, { status: 400 });
    }

    let body = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }

    const refreshPolicyHealth = parseRefreshPolicyHealth(body);
    const detail = await getAssessmentDetail(assessmentId);
    if (!detail.assessment) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const hasMatchedPolicy = Boolean(detail.policy);
    const policyHealthContextHash = buildPolicyHealthContextHash(detail);
    const useCachedPolicyHealth = canUseCachedPolicyHealth(detail, policyHealthContextHash, refreshPolicyHealth);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildSuggestFixPrompt(detail, {
      includePolicyHealth: hasMatchedPolicy && !useCachedPolicyHealth,
      cachedPolicyHealth: useCachedPolicyHealth ? detail.policyHealthCheck : null,
    });

    const message = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const parsed = parseJSON(message.content[0].text);
    const policyHealth = useCachedPolicyHealth
      ? normalizeCachedPolicyHealth(detail.policyHealthCheck, hasMatchedPolicy)
      : normalizePolicyHealth(parsed?.policyHealth, hasMatchedPolicy);
    const storedPolicyHealthCheck = (hasMatchedPolicy && !useCachedPolicyHealth)
      ? await upsertPolicyHealthCheck(detail, policyHealth, policyHealthContextHash)
      : detail.policyHealthCheck;
    const suggestionPayload = normalizeSuggestionPayload(detail, parsed, {
      policyHealth,
      policyHealthSource: hasMatchedPolicy
        ? (useCachedPolicyHealth ? 'cache_hit' : 'generated')
        : 'not_applicable',
      policyHealthGeneratedAt: storedPolicyHealthCheck?.generatedAt || null,
      policyHealthPromptVersion: storedPolicyHealthCheck?.promptVersion || (hasMatchedPolicy ? POLICY_HEALTH_PROMPT_VERSION : null),
      policyHealthCheckId: storedPolicyHealthCheck?.id || null,
    });
    const storedSuggestion = await upsertAssessmentFixSuggestion(
      detail,
      suggestionPayload,
      storedPolicyHealthCheck?.id || null,
    );

    return Response.json({
      ...suggestionPayload,
      implementationNotes: storedSuggestion?.implementationNotes || suggestionPayload.implementationNotes,
      implementationNotesText: storedSuggestion?.implementationNotesText || suggestionPayload.implementationNotesText,
      metadata: {
        ...suggestionPayload.metadata,
        suggestionId: storedSuggestion?.id || null,
        suggestionGeneratedAt: storedSuggestion?.generatedAt || null,
        suggestionPromptVersion: storedSuggestion?.promptVersion || SUGGEST_FIX_PROMPT_VERSION,
        suggestionSource: storedSuggestion ? 'saved' : 'generated',
      },
    });
  } catch (err) {
    console.error('Remediation suggest-fix error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
