import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');
    const state = searchParams.get('state');
    const sourceId = searchParams.get('source_id');
    const humanReviewed = searchParams.get('human_reviewed');
    const riskTier = searchParams.get('risk_tier');
    const runId = searchParams.get('run_id');
    const search = searchParams.get('search');
    const limit = Math.min(parseInt(searchParams.get('limit') || '500', 10), 2000);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    // Resolve run_id: use provided, or latest run
    let effectiveRunId = runId;
    if (!effectiveRunId) {
      const latestRun = await db.execute(sql`
        SELECT id FROM map_runs ORDER BY (status = 'completed') DESC, started_at DESC LIMIT 1
      `);
      const row = (latestRun.rows || latestRun)?.[0];
      effectiveRunId = row?.id || null;
    }

    // Run-scoped join condition
    const runJoin = effectiveRunId
      ? sql`LEFT JOIN coverage_assessments ca ON ca.obligation_id = o.id AND ca.map_run_id = ${effectiveRunId}`
      : sql`LEFT JOIN coverage_assessments ca ON ca.obligation_id = o.id`;

    // Build WHERE fragments
    const where = [];

    if (status && status !== 'all') {
      if (status === 'UNASSESSED') {
        where.push(sql`ca.id IS NULL`);
      } else {
        where.push(sql`COALESCE(ca.human_status, ca.status) = ${status}`);
      }
    }
    if (state && state !== 'all') {
      where.push(sql`(rs.state = ${state} OR rs.state IS NULL OR rs.state = 'ALL')`);
    }
    if (sourceId && sourceId !== 'all') {
      where.push(sql`rs.id = ${sourceId}`);
    }
    if (humanReviewed === 'true') {
      where.push(sql`ca.human_status IS NOT NULL`);
    } else if (humanReviewed === 'false') {
      where.push(sql`ca.human_status IS NULL AND ca.id IS NOT NULL`);
    }
    if (riskTier && riskTier !== 'all') {
      where.push(sql`o.risk_tier = ${riskTier}`);
    }
    if (search) {
      const q = `%${search}%`;
      where.push(sql`(o.citation ILIKE ${q} OR o.requirement ILIKE ${q} OR p.policy_number ILIKE ${q} OR ca.gap_detail ILIKE ${q} OR p.title ILIKE ${q})`);
    }

    const whereSQL = where.length > 0
      ? sql`WHERE ${sql.join(where, sql` AND `)}`
      : sql``;

    // Main query
    const results = await db.execute(sql`
      SELECT
        o.id as obligation_id, o.citation, o.requirement, o.source_type,
        o.topics, o.levels_of_care, o.responsible_party, o.timeframe,
        o.documentation_required, o.risk_tier,
        rs.id as source_id, rs.name as source_name, rs.state as source_state,
        ca.id as assessment_id, ca.status, ca.confidence, ca.gap_detail,
        ca.recommended_policy, ca.policy_id, ca.match_method, ca.match_score,
        ca.reasoning, ca.obligation_span, ca.provision_span, ca.assessed_by,
        ca.human_status, ca.reviewed_by, ca.reviewed_at, ca.review_notes,
        ca.map_run_id,
        COALESCE(ca.human_status, ca.status) as effective_status,
        p.policy_number, p.title as policy_title, p.domain as policy_domain
      FROM obligations o
      JOIN reg_sources rs ON o.reg_source_id = rs.id
      ${runJoin}
      LEFT JOIN policies p ON ca.policy_id = p.id
      ${whereSQL}
      ORDER BY rs.name, o.citation
      LIMIT ${limit} OFFSET ${offset}
    `);

    const rows = results.rows || results || [];

    // Summary counts in SQL
    const summaryResult = await db.execute(sql`
      SELECT
        count(*) as total,
        count(*) FILTER (WHERE COALESCE(ca.human_status, ca.status) = 'COVERED') as covered,
        count(*) FILTER (WHERE COALESCE(ca.human_status, ca.status) = 'PARTIAL') as partial,
        count(*) FILTER (WHERE COALESCE(ca.human_status, ca.status) = 'GAP') as gap,
        count(*) FILTER (WHERE COALESCE(ca.human_status, ca.status) = 'CONFLICTING') as conflicting,
        count(*) FILTER (WHERE ca.id IS NULL) as unassessed,
        count(*) FILTER (WHERE ca.human_status IS NOT NULL) as human_reviewed
      FROM obligations o
      JOIN reg_sources rs ON o.reg_source_id = rs.id
      ${runJoin}
      LEFT JOIN policies p ON ca.policy_id = p.id
      ${whereSQL}
    `);
    const s = (summaryResult.rows || summaryResult)?.[0] || {};

    // Tier counts
    const tierResult = await db.execute(sql`
      SELECT COALESCE(o.risk_tier, 'unclassified') as tier, count(*) as count
      FROM obligations o
      JOIN reg_sources rs ON o.reg_source_id = rs.id
      ${runJoin}
      LEFT JOIN policies p ON ca.policy_id = p.id
      ${whereSQL}
      GROUP BY o.risk_tier
    `);
    const tierCounts = {};
    for (const r of (tierResult.rows || tierResult || [])) {
      tierCounts[r.tier] = Number(r.count);
    }

    // Run info
    let runInfo = null;
    if (effectiveRunId) {
      const runResult = await db.execute(sql`
        SELECT id, label, state, scope, status, model_id, prompt_version,
               started_at, completed_at
        FROM map_runs WHERE id = ${effectiveRunId}
      `);
      runInfo = (runResult.rows || runResult)?.[0] || null;
    }

    return Response.json({
      rows,
      summary: {
        total: Number(s.total || 0),
        covered: Number(s.covered || 0),
        partial: Number(s.partial || 0),
        gap: Number(s.gap || 0),
        conflicting: Number(s.conflicting || 0),
        unassessed: Number(s.unassessed || 0),
        human_reviewed: Number(s.human_reviewed || 0),
      },
      tierCounts,
      run: runInfo,
      pagination: { limit, offset, returned: rows.length },
    });
  } catch (err) {
    console.error('Gaps error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
