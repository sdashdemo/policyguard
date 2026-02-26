import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 120;

const COVERAGE_PROMPT = (domain, requirementsJson, policiesText) => `You are mapping regulatory requirements against an organization's FULL policy library. Requirements are from the "${domain}" domain but may be covered by policies in ANY domain (clinical, medical, HR, admin, etc.).

REQUIREMENTS TO CHECK:
${requirementsJson}

ALL ORGANIZATIONAL POLICIES:
${policiesText}

For each requirement, determine coverage:
- COVERED: A policy provision FULLY addresses the specific obligation
- PARTIAL: The topic is addressed but key elements are missing (timeframe, responsible party, documentation, specific content required by regulation)
- GAP: No policy addresses this requirement
- DUPLICATE: Multiple policies address the same requirement (note which ones)

Important: A requirement can be covered by ANY policy regardless of domain. For example, a clinical requirement about medication storage might be covered by a medical or pharmacy policy. Check ALL policies.

Return a JSON object (no other text, no markdown fences):

{
  "coverage": [
    {
      "requirement_id": "R1",
      "citation": "The regulatory citation",
      "description": "Brief description of requirement",
      "status": "COVERED or PARTIAL or GAP or DUPLICATE",
      "covering_policy": "Policy ID(s) that cover this, or null",
      "gap_detail": "What's missing. Null if COVERED.",
      "recommended_policy": "For GAP/PARTIAL: which existing policy should this be added to, or 'NEW POLICY' if none fit. Null if COVERED."
    }
  ],
  "structural_issues": ["Only include significant cross-policy conflicts or coordination issues. Max 5 most important."]
}

Return ONLY the JSON object.`;

function parseJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON found in response');
  let jsonStr = text.slice(start);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const lastComplete = jsonStr.lastIndexOf('},');
    if (lastComplete > 0) {
      jsonStr = jsonStr.slice(0, lastComplete + 1) + ']}';
      try { return JSON.parse(jsonStr); } catch {}
    }
    const lastComplete2 = jsonStr.lastIndexOf('}');
    if (lastComplete2 > 0) {
      jsonStr = jsonStr.slice(0, lastComplete2 + 1) + ']}';
      try { return JSON.parse(jsonStr); } catch {}
    }
    throw new Error('Could not parse response JSON');
  }
}

export async function POST(req) {
  try {
    const { domain, requirements, policies } = await req.json();

    if (!domain || !requirements?.length || !policies?.length) {
      return Response.json({ error: 'Missing domain, requirements, or policies' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build compact policy summaries — ALL policies, not just domain-specific
    const policiesText = policies.map(p => {
      const provisions = (p.provisions || [])
        .slice(0, 15) // Keep top 15 provisions to manage token usage
        .map(prov => `  - ${prov.text}`)
        .join('\n');
      return `[${p.policy_id}] ${p.title} (${p.domain})\n${p.summary}\n${provisions}`;
    }).join('\n\n');

    // Truncate if needed but try to keep as much as possible
    const truncatedPolicies = policiesText.length > 80000
      ? policiesText.slice(0, 80000) + '\n\n[... additional policies truncated ...]'
      : policiesText;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      messages: [{
        role: 'user',
        content: COVERAGE_PROMPT(domain, JSON.stringify(requirements, null, 2), truncatedPolicies),
      }],
    });

    const parsed = parseJSON(message.content[0].text);
    return Response.json({
      coverage: parsed.coverage || [],
      structural_issues: parsed.structural_issues || [],
    });
  } catch (err) {
    console.error('Map coverage error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
