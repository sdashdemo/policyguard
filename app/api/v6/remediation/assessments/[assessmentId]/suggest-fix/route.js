import Anthropic from '@anthropic-ai/sdk';
import { getAssessmentDetail } from '@/lib/remediation';
import { MODEL_ID } from '@/lib/audit';
import { parseJSON } from '@/lib/parse';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

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

function buildSuggestFixPrompt(detail) {
  const assessment = detail.assessment;
  const obligation = detail.obligation;
  const policy = detail.policy;
  const provisions = detail.provisions || [];
  const noMatchedPolicyInstruction = !policy
    ? 'When no matched policy exists, draft the narrowest reviewer-usable provision language that directly addresses the specific cited regulatory requirement rather than writing a broad compliance policy. Anchor each sentence to a concrete obligation from the cited regulation. Do not include generic compliance boilerplate (for example, annual review, designated compliance officer, public posting, or reporting workflows) unless the cited regulation specifically supports it. Avoid alarmist or rhetorical language. If helpful, separate required draft language from optional implementation notes. For no-matched-policy rows, draft only the minimum policy provision language needed to address the cited requirement. Keep the draft to 1-3 sentences unless the citation clearly requires more detail. Do not assign roles, owners, compliance officers, leadership notifications, monitoring steps, renewal calendars, reporting workflows, or escalation processes unless the cited regulation expressly supports them. Avoid evaluative phrases like "critical compliance gap" and state the deficiency neutrally.\n'
    : '';

  return `You are PolicyGuard, helping a remediation reviewer draft a practical policy fix.

You are reviewing one remediation item. Produce a concise, reviewer-usable suggestion that can help a human revise policy language or document a remediation step.

Return a single JSON object with EXACTLY this structure and no markdown fences:
{
  "summary": "2-4 sentences explaining why this fix is suggested.",
  "suggestedFix": "Draft policy language or remediation guidance in plain text. Use paragraphs and bullets only if helpful.",
  "policyHealth": {
    "summary": "1-3 sentences about how healthy or fragile the matched policy looks for this obligation.",
    "issues": ["Short issue", "Short issue"]
  }
}

If there is no matched policy, still return a best-effort "summary" and "suggestedFix". In that case set "policyHealth" to null.

Guidance:
- Write for a compliance reviewer, not an engineer.
- Be concrete and operational.
- If the item is GAP, propose language or steps that would close the gap.
- If the item is PARTIAL, explain what is missing and draft the missing addition.
- If no matched policy exists, provide best-effort draft language or remediation guidance that could become a new policy section or interim corrective action.
- Do not mention JSON, prompts, or system internals.
- Do not recommend database changes, UI changes, or route changes.

${noMatchedPolicyInstruction}ASSESSMENT DETAIL
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
      issues: [],
    };
  }

  const issues = Array.isArray(rawPolicyHealth.issues)
    ? rawPolicyHealth.issues
      .map((value) => normalizeString(value))
      .filter(Boolean)
      .slice(0, 5)
    : [];

  return {
    summary: normalizeString(rawPolicyHealth.summary) || 'Matched policy review was unavailable.',
    issues,
  };
}

function normalizeSuggestionPayload(detail, parsed) {
  const hasMatchedPolicy = Boolean(detail.policy);

  return {
    ok: true,
    assessmentId: detail.assessment.id,
    summary: normalizeString(parsed?.summary)
      || (hasMatchedPolicy
        ? 'A matched policy was available, so the suggestion focuses on closing the identified coverage gap or weakness.'
        : 'No matched policy was available, so the suggestion provides best-effort remediation language and next-step guidance.'),
    suggestedFix: normalizeString(parsed?.suggestedFix)
      || (hasMatchedPolicy
        ? 'No draft policy language was returned.'
        : 'No matched policy was available. Draft a new policy section or corrective-action language that directly addresses the cited requirement.'),
    policyHealth: normalizePolicyHealth(parsed?.policyHealth, hasMatchedPolicy),
    metadata: {
      hasMatchedPolicy,
      policyNumber: detail.policy?.policyNumber || null,
    },
  };
}

export async function POST(req, { params }) {
  try {
    const assessmentId = normalizeString(params?.assessmentId);
    if (!assessmentId) {
      return Response.json({ error: 'Missing assessmentId' }, { status: 400 });
    }

    const detail = await getAssessmentDetail(assessmentId);
    if (!detail.assessment) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const prompt = buildSuggestFixPrompt(detail);

    const message = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const parsed = parseJSON(message.content[0].text);
    return Response.json(normalizeSuggestionPayload(detail, parsed));
  } catch (err) {
    console.error('Remediation suggest-fix error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
