import { db } from '@/lib/db';
import { obligations, regSources } from '@/lib/schema';
import { sql, eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { logAuditEvent, PROMPT_VERSIONS, MODEL_ID } from '@/lib/audit';

export const maxDuration = 300;

// Process one reg source per call. Frontend loops through sources.
// Each source is chunked into ~40K char pieces to stay within context.

const CHUNK_SIZE = 40000;
const CHUNK_OVERLAP = 1000;

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}

function ulid(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}_${rand}`;
}

const EXTRACT_PROMPT = (sourceName, sourceType, citationRoot, chunkText, chunkIdx, totalChunks) => `You are a regulatory compliance expert for behavioral health facilities (substance use disorder and mental health treatment).

Extract every distinct operational obligation from this regulatory/standards source.

SOURCE: ${sourceName}
TYPE: ${sourceType}
CITATION PREFIX: ${citationRoot || 'N/A'}
CHUNK: ${chunkIdx + 1} of ${totalChunks}

TEXT:
${chunkText}

INSTRUCTIONS:
- Extract each distinct obligation, standard, or requirement as a separate item.
- For TJC: each Element of Performance (EP) is typically one requirement. Include the standard number (e.g., PC.01.02.01 EP 3).
- For state regulations: each subsection with a distinct obligation is one requirement.
- CONSOLIDATE related sub-items that are all part of the same requirement into ONE item.
- Skip requirements purely administrative to the licensing agency (application forms, fee schedules, renewal procedures, definitions-only sections).
- Include the exact citation (section/subsection number).
- Tag each with a topic category.

EXCLUDE these categories (not applicable to this organization):
- Methadone-specific OTP requirements (buprenorphine MAT requirements ARE applicable)
- Juvenile justice services
- Child welfare or pediatric-specific requirements
- Prevention services
- CCBHC certification requirements

Return a JSON object (no other text, no markdown fences):

{
  "requirements": [
    {
      "citation": "Specific citation (e.g., 65D-30.004(6)(a), PC.01.02.01 EP 1)",
      "requirement": "Clear statement of the operational obligation",
      "source_span": "Brief quote from the source text that grounds this obligation (15-30 words)",
      "topic": "One of: assessment, treatment_planning, documentation, medical_director, medication_management, infection_control, patient_rights, consent, discharge, case_management, counseling, supervision, emergency_management, incident_reporting, overdose_prevention, telehealth, drug_screening, patient_education, staffing, medical_protocols, quality_improvement, environment_of_care, information_management, privacy_confidentiality, admissions, grievances, abuse_neglect, restraint_seclusion, dietary, laboratory, governance, utilization_review, performance_improvement, other"
    }
  ]
}

Return ONLY the JSON object.`;

function parseJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON found in response');
  let jsonStr = text.slice(start);
  try { return JSON.parse(jsonStr); } catch {}
  // Try truncated recovery
  const lastComplete = jsonStr.lastIndexOf('},');
  if (lastComplete > 0) {
    jsonStr = jsonStr.slice(0, lastComplete + 1) + ']}';
    try { return JSON.parse(jsonStr); } catch {}
  }
  const lastBrace = jsonStr.lastIndexOf('}');
  if (lastBrace > 0) {
    jsonStr = jsonStr.slice(0, lastBrace + 1) + ']}';
    try { return JSON.parse(jsonStr); } catch {}
  }
  throw new Error('Could not parse extraction response');
}

export async function GET() {
  // Return list of reg sources with extraction status
  try {
    const sources = await db.execute(sql`
      SELECT rs.id, rs.name, rs.state, rs.source_type, rs.citation_root,
        LENGTH(rs.full_text) as text_length,
        (SELECT count(*) FROM obligations o WHERE o.reg_source_id = rs.id) as obligation_count
      FROM reg_sources rs
      ORDER BY rs.name
    `);
    return Response.json({ sources: sources.rows || sources });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { source_id } = await req.json();

    if (!source_id) {
      return Response.json({ error: 'source_id required' }, { status: 400 });
    }

    // Get the source
    const [source] = await db.select().from(regSources).where(eq(regSources.id, source_id));
    if (!source) {
      return Response.json({ error: 'Source not found' }, { status: 404 });
    }

    const chunks = chunkText(source.full_text);
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    let allRequirements = [];
    const chunkErrors = [];

    for (let i = 0; i < chunks.length; i++) {
      try {
        const message = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 16000,
          messages: [{
            role: 'user',
            content: EXTRACT_PROMPT(
              source.name,
              source.source_type,
              source.citation_root,
              chunks[i],
              i,
              chunks.length
            )
          }],
        });

        const parsed = parseJSON(message.content[0].text);
        const reqs = parsed.requirements || [];
        allRequirements = allRequirements.concat(reqs);
      } catch (err) {
        chunkErrors.push({ chunk: i, error: err.message });
      }
    }

    // Deduplicate by citation
    const seen = new Map();
    for (const req of allRequirements) {
      const key = req.citation?.trim();
      if (key && !seen.has(key)) {
        seen.set(key, req);
      } else if (!key) {
        seen.set(`_nokey_${seen.size}`, req);
      }
    }
    const deduped = Array.from(seen.values());

    // Store in obligations table
    let inserted = 0;
    for (const req of deduped) {
      try {
        const id = ulid('obl');
        await db.insert(obligations).values({
          id,
          reg_source_id: source.id,
          citation: req.citation || 'uncited',
          requirement: req.requirement,
          source_type: source.source_type,
          topics: [req.topic || 'other'],
        });
        inserted++;
      } catch (err) {
        // Skip duplicates or insert errors
      }
    }

    await logAuditEvent({
      event_type: 'extraction',
      entity_type: 'reg_source',
      entity_id: source.id,
      actor: 'system',
      input_summary: `${source.name} — ${chunks.length} chunks, ${source.full_text.length} chars`,
      output_summary: `${allRequirements.length} raw → ${deduped.length} deduped → ${inserted} inserted`,
      model_id: MODEL_ID,
      prompt_version: 'extract_v2',
    });

    return Response.json({
      ok: true,
      source_id: source.id,
      source_name: source.name,
      chunks_processed: chunks.length,
      raw_extracted: allRequirements.length,
      deduped: deduped.length,
      inserted,
      chunk_errors: chunkErrors,
    });

  } catch (err) {
    console.error('Extraction error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
