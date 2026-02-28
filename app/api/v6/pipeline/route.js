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
        (SELECT count(DISTINCT obligation_id) FROM coverage_assessments) as assessed_obligations,
        (SELECT count(*) FROM coverage_assessments WHERE human_status IS NOT NULL) as reviewed,
        (SELECT count(*) FROM action_items) as action_items,
        (SELECT count(*) FROM audit_events) as audit_events
    `);
    const r = (counts.rows || counts)[0];

    const totalObls = Number(r.obligations);
    const oblsEmbedded = Number(r.obligations_embedded);
    const totalProvs = Number(r.provisions);
    const provsEmbedded = Number(r.provisions_embedded);
    const totalPolicies = Number(r.policies);
    const policiesIndexed = Number(r.policies_indexed);
    const policiesUploaded = Number(r.policies_uploaded);
    const assessedObls = Number(r.assessed_obligations);

    const oblsRemaining = totalObls - oblsEmbedded;
    const provsRemaining = totalProvs - provsEmbedded;
    const embedRemaining = oblsRemaining + provsRemaining;
    const assessRemaining = totalObls - assessedObls;
    const indexRemaining = totalPolicies - policiesIndexed;

    // Determine step statuses with proper completion semantics
    function stepStatus(started, remaining, prereqMet) {
      if (!prereqMet) return 'blocked';
      if (started === 0) return 'ready';
      if (remaining === 0) return 'done';
      return 'in_progress';
    }

    const steps = [
      {
        id: 'upload_regs',
        label: '1. Upload Regulatory Sources',
        status: Number(r.reg_sources) > 0 ? 'done' : 'pending',
        detail: `${r.reg_sources} sources uploaded`,
      },
      {
        id: 'extract_obligations',
        label: '2. Extract Obligations',
        status: stepStatus(totalObls, 0, Number(r.reg_sources) > 0),
        detail: `${totalObls} obligations extracted`,
      },
      {
        id: 'upload_policies',
        label: '3. Upload Policies',
        status: totalPolicies > 0 ? 'done' : 'pending',
        detail: `${totalPolicies} policies (${policiesUploaded} uploaded, ${policiesIndexed} indexed)`,
      },
      {
        id: 'index_policies',
        label: '4. Index Policies → Provisions',
        status: stepStatus(policiesIndexed, indexRemaining, totalPolicies > 0),
        detail: indexRemaining > 0
          ? `${policiesIndexed} indexed, ${indexRemaining} remaining · ${totalProvs} provisions`
          : `${totalProvs} provisions from ${policiesIndexed} policies`,
      },
      {
        id: 'embed',
        label: '5. Generate Embeddings',
        status: stepStatus(
          oblsEmbedded + provsEmbedded,
          embedRemaining,
          totalObls > 0 && totalProvs > 0
        ),
        detail: embedRemaining > 0
          ? `${oblsEmbedded}/${totalObls} obligations · ${provsEmbedded}/${totalProvs} provisions · ${embedRemaining} remaining`
          : `${oblsEmbedded} obligations + ${provsEmbedded} provisions embedded`,
      },
      {
        id: 'assess',
        label: '6. Run Coverage Assessment',
        status: stepStatus(
          assessedObls,
          assessRemaining,
          oblsEmbedded > 0 && provsEmbedded > 0
        ),
        detail: assessRemaining > 0
          ? `${assessedObls} assessed, ${assessRemaining} remaining (${r.reviewed} reviewed)`
          : `${assessedObls} assessed (${r.reviewed} reviewed)`,
      },
    ];

    // Latest run info
    const latestRun = await db.execute(sql`
      SELECT id, label, state, scope, status, started_at, completed_at
      FROM map_runs ORDER BY created_at DESC LIMIT 1
    `);

    return Response.json({
      steps,
      raw: r,
      latestRun: (latestRun.rows || latestRun)?.[0] || null,
    });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
