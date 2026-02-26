import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { generateEmbeddings, toPgVector } from '@/lib/embeddings';
import { logAuditEvent } from '@/lib/audit';

export const maxDuration = 300;

export async function POST(req) {
  try {
    const body = await req.json();
    const { target } = body; // 'obligations', 'provisions', or 'all'

    const results = { obligations: 0, provisions: 0, errors: [] };

    if (target === 'obligations' || target === 'all') {
      const obls = await db.execute(sql`
        SELECT id, citation, requirement FROM obligations WHERE embedding IS NULL LIMIT 200
      `);
      const rows = obls.rows || obls || [];

      if (rows.length > 0) {
        const texts = rows.map(r => `${r.citation}: ${r.requirement}`);
        try {
          const embeddings = await generateEmbeddings(texts);
          for (let i = 0; i < rows.length; i++) {
            const vecStr = toPgVector(embeddings[i]);
            await db.execute(sql`
              UPDATE obligations SET embedding = ${vecStr}::vector WHERE id = ${rows[i].id}
            `);
            results.obligations++;
          }
        } catch (err) {
          results.errors.push(`Obligation embedding error: ${err.message}`);
        }
      }
    }

    if (target === 'provisions' || target === 'all') {
      const provs = await db.execute(sql`
        SELECT id, text, section FROM provisions WHERE embedding IS NULL LIMIT 200
      `);
      const rows = provs.rows || provs || [];

      if (rows.length > 0) {
        const texts = rows.map(r => `${r.section || ''}: ${r.text}`);
        try {
          const embeddings = await generateEmbeddings(texts);
          for (let i = 0; i < rows.length; i++) {
            const vecStr = toPgVector(embeddings[i]);
            await db.execute(sql`
              UPDATE provisions SET embedding = ${vecStr}::vector WHERE id = ${rows[i].id}
            `);
            results.provisions++;
          }
        } catch (err) {
          results.errors.push(`Provision embedding error: ${err.message}`);
        }
      }
    }

    // Check remaining
    const remaining = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM obligations WHERE embedding IS NULL) as obls_remaining,
        (SELECT count(*) FROM provisions WHERE embedding IS NULL) as provs_remaining,
        (SELECT count(*) FROM obligations WHERE embedding IS NOT NULL) as obls_done,
        (SELECT count(*) FROM provisions WHERE embedding IS NOT NULL) as provs_done
    `);

    const rem = (remaining.rows || remaining)[0];

    await logAuditEvent({
      event_type: 'embedding',
      entity_type: target,
      actor: 'system',
      output_summary: `Embedded ${results.obligations} obligations, ${results.provisions} provisions`,
      metadata: { ...results, remaining: rem },
    });

    return Response.json({
      ok: true,
      embedded: results,
      remaining: rem,
      message: `Embedded ${results.obligations} obligations + ${results.provisions} provisions. ${Number(rem.obls_remaining) + Number(rem.provs_remaining)} remaining.`,
    });

  } catch (err) {
    console.error('Embed error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
