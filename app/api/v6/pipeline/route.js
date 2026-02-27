import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const counts = await db.execute(sql`
      SELECT
        (SELECT count(*) FROM reg_sources) as reg_sources,
        (SELECT count(*) FROM obligations) as obligations,
        (SELECT count(*) FROM obligations WHERE embedding IS NOT NULL) as obligations_embedded,
        (SELECT count(*) FROM policies) as policies,
        (SELECT count(*) FROM policies WHERE status = 'uploaded') as policies_uploaded,
        (SELECT count(*) FROM policies WHERE status = 'indexed') as policies_indexed,
        (SELECT count(*) FROM policies WHERE indexed_at IS NOT NULL) as policies_with_provisions,
        (SELECT count(*) FROM provisions) as provisions,
        (SELECT count(*) FROM provisions WHERE embedding IS NOT NULL) as provisions_embedded,
        (SELECT count(*) FROM coverage_assessments) as assessments,
        (SELECT count(*) FROM coverage_assessments WHERE human_status IS NOT NULL) as reviewed,
        (SELECT count(*) FROM action_items) as action_items,
        (SELECT count(*) FROM audit_events) as audit_events
    `);

    const row = (counts.rows || counts)[0];

    // Determine pipeline state
    const steps = [
      {
        id: 'upload_regs',
        label: '1. Upload Regulatory Sources',
        status: Number(row.reg_sources) > 0 ? 'done' : 'pending',
        count: Number(row.reg_sources),
        detail: `${row.reg_sources} sources uploaded`,
      },
      {
        id: 'extract_obligations',
        label: '2. Extract Obligations',
        status: Number(row.obligations) > 0 ? 'done' : Number(row.reg_sources) > 0 ? 'ready' : 'blocked',
        count: Number(row.obligations),
        detail: `${row.obligations} obligations extracted`,
      },
      {
        id: 'upload_policies',
        label: '3. Upload Policies',
        status: Number(row.policies) > 0 ? 'done' : 'pending',
        count: Number(row.policies),
        detail: `${row.policies} policies (${row.policies_uploaded} uploaded, ${row.policies_indexed} indexed)`,
      },
      {
        id: 'index_policies',
        label: '4. Index Policies → Provisions',
        status: Number(row.provisions) > 0 ? 'done' : Number(row.policies) > 0 ? 'ready' : 'blocked',
        count: Number(row.provisions),
        detail: `${row.provisions} provisions from ${row.policies_with_provisions} policies`,
      },
      {
        id: 'embed',
        label: '5. Generate Embeddings',
        status: (Number(row.obligations_embedded) > 0 || Number(row.provisions_embedded) > 0) ? 'done' : (Number(row.obligations) > 0 && Number(row.provisions) > 0) ? 'ready' : 'blocked',
        count: Number(row.obligations_embedded) + Number(row.provisions_embedded),
        detail: `${row.obligations_embedded}/${row.obligations} obligations · ${row.provisions_embedded}/${row.provisions} provisions`,
      },
      {
        id: 'assess',
        label: '6. Run Coverage Assessment',
        status: Number(row.assessments) > 0 ? 'done' : (Number(row.obligations_embedded) > 0 && Number(row.provisions_embedded) > 0) ? 'ready' : 'blocked',
        count: Number(row.assessments),
        detail: `${row.assessments} assessments (${row.reviewed} reviewed)`,
      },
    ];

    return Response.json({ steps, raw: row });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
