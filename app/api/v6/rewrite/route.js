import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { policies, coverageAssessments, obligations, regSources } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { REWRITE_PROMPT } from '@/lib/prompts';
import { MODEL_ID } from '@/lib/audit';

export const maxDuration = 120;

export async function POST(req) {
  try {
    const { policy_id, policy_number } = await req.json();

    if (!policy_id && !policy_number) {
      return Response.json({ error: 'Missing policy_id or policy_number' }, { status: 400 });
    }

    // Find the policy
    let policy;
    if (policy_id) {
      const [p] = await db.select().from(policies).where(eq(policies.id, policy_id));
      policy = p;
    } else {
      const results = await db.execute(sql`
        SELECT * FROM policies WHERE policy_number = ${policy_number} LIMIT 1
      `);
      policy = (results.rows || results)[0];
    }

    if (!policy) {
      return Response.json({ error: 'Policy not found' }, { status: 404 });
    }

    // Get all assessments linked to this policy (PARTIAL, GAP, CONFLICTING)
    const assessments = await db.execute(sql`
      SELECT 
        ca.status, ca.gap_detail, ca.recommended_policy,
        ca.obligation_span, ca.provision_span, ca.reasoning,
        o.citation, o.requirement, o.source_type,
        rs.name as source_name
      FROM coverage_assessments ca
      JOIN obligations o ON ca.obligation_id = o.id
      JOIN reg_sources rs ON o.reg_source_id = rs.id
      WHERE (ca.policy_id = ${policy.id} OR ca.recommended_policy = ${policy.policy_number})
        AND ca.status IN ('PARTIAL', 'GAP', 'CONFLICTING')
      ORDER BY o.citation
    `);

    const assigned = assessments.rows || assessments || [];

    if (assigned.length === 0) {
      return Response.json({ error: 'No gaps or partials linked to this policy' }, { status: 400 });
    }

    // Get sibling coverage (other policies covering related obligations)
    const siblings = await db.execute(sql`
      SELECT DISTINCT
        ca.status, o.citation, o.requirement,
        p2.policy_number as covered_by
      FROM coverage_assessments ca
      JOIN obligations o ON ca.obligation_id = o.id
      JOIN policies p2 ON ca.policy_id = p2.id
      WHERE ca.policy_id != ${policy.id}
        AND ca.status IN ('COVERED', 'PARTIAL')
        AND o.reg_source_id IN (
          SELECT DISTINCT o2.reg_source_id FROM obligations o2
          JOIN coverage_assessments ca2 ON ca2.obligation_id = o2.id
          WHERE ca2.policy_id = ${policy.id} OR ca2.recommended_policy = ${policy.policy_number}
        )
      LIMIT 50
    `);

    const siblingRows = siblings.rows || siblings || [];

    // Get regulation text for context (first 60K chars of relevant sources)
    const sourceIds = [...new Set(assigned.map(a => a.source_name))];
    let regText = '';
    for (const name of sourceIds.slice(0, 3)) {
      const src = await db.execute(sql`
        SELECT full_text FROM reg_sources WHERE name = ${name} LIMIT 1
      `);
      const row = (src.rows || src)[0];
      if (row?.full_text) {
        regText += `SOURCE: ${name}\n\n${row.full_text.slice(0, 20000)}\n\n---\n\n`;
      }
    }
    regText = regText.slice(0, 60000);

    // Build the prompt
    const assignedJson = JSON.stringify(assigned.map(a => ({
      citation: a.citation,
      requirement: a.requirement,
      status: a.status,
      gap_detail: a.gap_detail,
      source: a.source_name,
    })), null, 2);

    const siblingJson = JSON.stringify(siblingRows.map(s => ({
      req: `${s.citation}: ${s.requirement?.slice(0, 100)}`,
      covered_by: s.covered_by,
      status: s.status,
    })), null, 2);

    const prompt = REWRITE_PROMPT(
      policy.policy_number || policy.id,
      policy.title,
      (policy.full_text || '').slice(0, 40000),
      policy.domain || 'unknown',
      regText,
      assignedJson,
      siblingJson
    );

    // Stream the response
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const stream = client.messages.stream({
      model: MODEL_ID,
      max_tokens: 8096,
      messages: [{ role: 'user', content: prompt }],
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta?.text) {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });

  } catch (err) {
    console.error('Rewrite error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
