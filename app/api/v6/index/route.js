import { db } from '@/lib/db';
import { policies, provisions } from '@/lib/schema';
import { sql, eq } from 'drizzle-orm';
import Anthropic from '@anthropic-ai/sdk';
import { logAuditEvent, MODEL_ID } from '@/lib/audit';
import { INDEX_PROMPT } from '@/lib/prompts';

export const maxDuration = 120;

function ulid(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}_${rand}`;
}

function parseJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON found');
  let jsonStr = text.slice(start);
  try { return JSON.parse(jsonStr); } catch {}
  const lastBrace = jsonStr.lastIndexOf('}');
  if (lastBrace > 0) {
    try { return JSON.parse(jsonStr.slice(0, lastBrace + 1)); } catch {}
  }
  throw new Error('Could not parse index response');
}

// GET: return next batch of unindexed policies
export async function GET() {
  try {
    const result = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM policies) as total,
        (SELECT count(*) FROM policies WHERE indexed_at IS NOT NULL) as indexed,
        (SELECT count(*) FROM policies WHERE indexed_at IS NULL) as unindexed,
        (SELECT count(*) FROM provisions) as provisions
    `);
    const row = (result.rows || result)[0];

    // Get next unindexed policy
    const next = await db.execute(sql`
      SELECT id, title, source_file, LENGTH(full_text) as text_length
      FROM policies
      WHERE indexed_at IS NULL
      ORDER BY title
      LIMIT 1
    `);
    const nextPolicy = (next.rows || next)[0] || null;

    return Response.json({
      total: Number(row.total),
      indexed: Number(row.indexed),
      unindexed: Number(row.unindexed),
      provisions: Number(row.provisions),
      next: nextPolicy,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// POST: index one policy
export async function POST(req) {
  try {
    const { policy_id } = await req.json();

    // If no policy_id, get the next unindexed one
    let targetId = policy_id;
    if (!targetId) {
      const next = await db.execute(sql`
        SELECT id FROM policies WHERE indexed_at IS NULL ORDER BY title LIMIT 1
      `);
      const row = (next.rows || next)[0];
      if (!row) {
        return Response.json({ ok: true, done: true, message: 'All policies indexed' });
      }
      targetId = row.id;
    }

    const [policy] = await db.select().from(policies).where(eq(policies.id, targetId));
    if (!policy) {
      return Response.json({ error: 'Policy not found' }, { status: 404 });
    }

    if (!policy.full_text || policy.full_text.length < 20) {
      // Mark as indexed but skip — no text
      await db.update(policies).set({ indexed_at: new Date(), status: 'empty' }).where(eq(policies.id, targetId));
      return Response.json({ ok: true, skipped: true, reason: 'No text content', policy_id: targetId });
    }

    // Truncate very long policies to fit in context
    const text = policy.full_text.length > 80000 ? policy.full_text.slice(0, 80000) : policy.full_text;

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await client.messages.create({
      model: MODEL_ID,
      max_tokens: 16000,
      messages: [{ role: 'user', content: INDEX_PROMPT(policy.source_file || policy.title, text) }],
    });

    const parsed = parseJSON(message.content[0].text);

    // Update policy metadata
    await db.update(policies).set({
      policy_number: parsed.policy_id || null,
      title: parsed.title || policy.title,
      domain: parsed.domain || null,
      facility_name: parsed.facility_name || null,
      effective_date: parsed.effective_date || null,
      revision_dates: parsed.revision_dates || null,
      purpose: parsed.purpose || null,
      summary: parsed.summary || null,
      dcf_citations: parsed.dcf_citations || [],
      tjc_citations: parsed.tjc_citations || [],
      section_headings: parsed.section_headings || [],
      topics_covered: parsed.topics_covered || [],
      header_issues: parsed.header_issues || [],
      indexed_at: new Date(),
      status: 'indexed',
    }).where(eq(policies.id, targetId));

    // Insert provisions
    let provInserted = 0;
    const provs = parsed.provisions || [];
    for (const prov of provs) {
      if (!prov.text || prov.text.trim().length < 10) continue;
      try {
        await db.insert(provisions).values({
          id: ulid('prov'),
          policy_id: targetId,
          text: prov.text,
          section: prov.section || null,
          source_citation: prov.source || null,
        });
        provInserted++;
      } catch (err) {
        // skip dupes
      }
    }

    // Count remaining
    const remaining = await db.execute(sql`
      SELECT count(*) as c FROM policies WHERE indexed_at IS NULL
    `);
    const left = Number((remaining.rows || remaining)[0].c);

    return Response.json({
      ok: true,
      done: left === 0,
      policy_id: targetId,
      policy_number: parsed.policy_id,
      title: parsed.title,
      domain: parsed.domain,
      provisions_extracted: provs.length,
      provisions_inserted: provInserted,
      remaining: left,
    });

  } catch (err) {
    console.error('Index error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
