import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 300;

const EXTRACT_PROMPT = (domain, sourceName, sourceText) => `You are a regulatory compliance expert for behavioral health organizations. Extract EVERY requirement from this regulatory/standards source that applies to the "${domain}" domain.

SOURCE: ${sourceName}

TEXT:
${sourceText}

INSTRUCTIONS:
- Extract EVERY distinct obligation, standard, or requirement. Be EXHAUSTIVE.
- Split compound requirements into separate items. If one subsection requires three distinct things, that's three entries.
- For TJC: each Element of Performance (EP) is a separate requirement.
- For state regulations: each subsection with a distinct "shall", "must", or "required" is a separate requirement.
- Include timeframes, responsible parties, documentation requirements.
- Only include requirements relevant to the "${domain}" domain.
- Use sequential IDs starting with R1.

Return a JSON object (no other text, no markdown fences, no explanation):

{
  "requirements": [
    {
      "id": "R1",
      "source_type": "state_reg or tjc",
      "citation": "Specific citation at the subsection/EP level",
      "requirement": "Clear statement of what must be done",
      "responsible_party": "Who is responsible",
      "timeframe": "Deadline or frequency, or null",
      "documentation": "What must be documented, or null",
      "topic": "Brief topic label (e.g., discharge planning, treatment plans, assessment, staffing, documentation)"
    }
  ]
}

Return ONLY the JSON object.`;


const COVERAGE_PROMPT = (domain, requirementsJson, policiesText) => `Map these regulatory requirements against existing policy provisions. Be STRICT about what counts as COVERED.

DOMAIN: ${domain}

REQUIREMENTS:
${requirementsJson}

EXISTING POLICIES AND PROVISIONS:
${policiesText}

For each requirement, determine coverage status:
- COVERED: A policy provision FULLY addresses the specific obligation with language that satisfies it
- PARTIAL: The topic is addressed but specific elements are missing (timeframe, responsible party, documentation, etc.)
- GAP: No policy addresses this requirement at all
- DUPLICATE: Multiple policies address the same requirement
- CONFLICTING: Policies address it differently

Return a JSON object (no other text, no markdown fences):

{
  "coverage": [
    {
      "requirement_id": "R1",
      "citation": "The citation",
      "description": "Brief description",
      "status": "COVERED or PARTIAL or GAP or DUPLICATE or CONFLICTING",
      "covering_policy": "Policy ID that covers this, or null",
      "covering_provision": "Exact provision text, or null",
      "gap_detail": "What's missing or needs adding. Null if fully COVERED.",
      "recommended_policy": "For GAP/PARTIAL: which policy should this be added to. Null if COVERED."
    }
  ],
  "summary": {
    "total": 0, "covered": 0, "partial": 0, "gap": 0, "duplicate": 0, "conflicting": 0
  },
  "structural_issues": ["Cross-policy issues found"]
}

Return ONLY the JSON object.`;


function parseJSON(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}') + 1;
  if (start < 0 || end <= start) throw new Error('No JSON found in response');
  return JSON.parse(text.slice(start, end));
}


export async function POST(req) {
  try {
    const { domain, regulations, policies } = await req.json();

    if (!domain || !regulations || !policies?.length) {
      return Response.json({ error: 'Missing domain, regulations, or policies' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // ── PHASE 1: Extract requirements from EACH regulation source separately ──
    let allRequirements = [];
    let reqCounter = 1;

    for (const [sourceName, sourceText] of Object.entries(regulations)) {
      // Split large sources into chunks (~40k chars each to stay well within limits)
      const chunkSize = 40000;
      const chunks = [];

      if (sourceText.length <= chunkSize) {
        chunks.push(sourceText);
      } else {
        // Split at paragraph boundaries
        const paragraphs = sourceText.split(/\n\n+/);
        let current = '';
        for (const para of paragraphs) {
          if (current.length + para.length > chunkSize && current.length > 0) {
            chunks.push(current);
            current = para;
          } else {
            current += (current ? '\n\n' : '') + para;
          }
        }
        if (current) chunks.push(current);
      }

      for (let i = 0; i < chunks.length; i++) {
        const chunkLabel = chunks.length > 1
          ? `${sourceName} (part ${i + 1}/${chunks.length})`
          : sourceName;

        try {
          const message = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 8096,
            messages: [{
              role: 'user',
              content: EXTRACT_PROMPT(domain, chunkLabel, chunks[i]),
            }],
          });

          const parsed = parseJSON(message.content[0].text);
          const reqs = parsed.requirements || [];

          // Re-number to avoid ID collisions across sources
          for (const r of reqs) {
            r.id = `R${reqCounter++}`;
            r.source_name = sourceName;
            allRequirements.push(r);
          }
        } catch (err) {
          console.error(`Error extracting from ${chunkLabel}:`, err.message);
        }
      }
    }

    if (allRequirements.length === 0) {
      return Response.json({
        error: 'No requirements extracted. Check that regulation files contain relevant text.',
      }, { status: 400 });
    }

    // ── PHASE 2: Map coverage - batch policies to avoid context overflow ──
    // Build compact policy summaries
    const policyEntries = policies.map(p => {
      const provisions = (p.provisions || [])
        .map(prov => `  - ${prov.text}${prov.source ? ` [${prov.source}]` : ''}`)
        .join('\n');
      return {
        text: `POLICY: ${p.policy_id} — ${p.title}\nCovers: ${p.summary}\nProvisions:\n${provisions}`,
        id: p.policy_id,
      };
    });

    // Batch policies into groups that fit in context
    const maxPoliciesTextLen = 50000;
    const policyBatches = [];
    let currentBatch = [];
    let currentLen = 0;

    for (const entry of policyEntries) {
      if (currentLen + entry.text.length > maxPoliciesTextLen && currentBatch.length > 0) {
        policyBatches.push(currentBatch);
        currentBatch = [entry];
        currentLen = entry.text.length;
      } else {
        currentBatch.push(entry);
        currentLen += entry.text.length;
      }
    }
    if (currentBatch.length > 0) policyBatches.push(currentBatch);

    // Also batch requirements if there are many
    const reqBatchSize = 30;
    const reqBatches = [];
    for (let i = 0; i < allRequirements.length; i += reqBatchSize) {
      reqBatches.push(allRequirements.slice(i, i + reqBatchSize));
    }

    let allCoverage = [];
    let allStructuralIssues = [];

    for (const reqBatch of reqBatches) {
      // For each requirement batch, check against ALL policies
      const fullPoliciesText = policyBatches.length === 1
        ? policyBatches[0].map(p => p.text).join('\n\n---\n\n')
        : policyEntries.map(p => p.text).join('\n\n---\n\n');

      // If policies text is too long, summarize
      const policiesText = fullPoliciesText.length > 60000
        ? fullPoliciesText.slice(0, 60000) + '\n\n[... additional policies truncated ...]'
        : fullPoliciesText;

      try {
        const message = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8096,
          messages: [{
            role: 'user',
            content: COVERAGE_PROMPT(
              domain,
              JSON.stringify(reqBatch, null, 2),
              policiesText
            ),
          }],
        });

        const parsed = parseJSON(message.content[0].text);
        allCoverage.push(...(parsed.coverage || []));
        if (parsed.structural_issues) {
          allStructuralIssues.push(...parsed.structural_issues);
        }
      } catch (err) {
        console.error('Error mapping coverage batch:', err.message);
      }
    }

    // Deduplicate structural issues
    allStructuralIssues = [...new Set(allStructuralIssues)];

    // Calculate summary
    const summary = { total: 0, covered: 0, partial: 0, gap: 0, duplicate: 0, conflicting: 0 };
    for (const c of allCoverage) {
      summary.total++;
      const s = (c.status || '').toUpperCase();
      if (s === 'COVERED') summary.covered++;
      else if (s === 'PARTIAL') summary.partial++;
      else if (s === 'GAP') summary.gap++;
      else if (s === 'DUPLICATE') summary.duplicate++;
      else if (s === 'CONFLICTING') summary.conflicting++;
    }

    return Response.json({
      domain,
      generated: new Date().toISOString(),
      requirements: allRequirements,
      coverage: allCoverage,
      summary,
      structural_issues: allStructuralIssues,
    });
  } catch (err) {
    console.error('Map error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
