import { db } from '@/lib/db';
import { policies, provisions, obligations, subDomainLabels } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import { findCandidates } from '@/lib/matching';

export async function POST(req) {
  try {
    const { obligation_id, obligation } = await req.json();

    // Get the obligation — either by ID from DB or passed directly
    let obl = obligation;
    if (obligation_id && !obl) {
      const rows = await db.select().from(obligations).where(eq(obligations.id, obligation_id));
      if (rows.length === 0) return Response.json({ error: 'Obligation not found' }, { status: 404 });
      obl = rows[0];
    }
    if (!obl) return Response.json({ error: 'Missing obligation_id or obligation' }, { status: 400 });

    // Load all policies, provisions, and sub-domain labels
    const allPolicies = await db.select().from(policies);
    const allProvisions = await db.select().from(provisions);
    const allLabels = await db.select().from(subDomainLabels);

    // Run candidate matching
    const candidates = findCandidates(obl, allPolicies, allProvisions, allLabels);

    return Response.json({
      obligation: {
        id: obl.id,
        citation: obl.citation,
        requirement: obl.requirement,
      },
      candidates,
      total_policies_searched: allPolicies.length,
    });

  } catch (err) {
    console.error('Match error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Batch mode: match multiple obligations at once
export async function PUT(req) {
  try {
    const { obligation_ids, limit } = await req.json();
    if (!obligation_ids?.length) return Response.json({ error: 'Missing obligation_ids' }, { status: 400 });

    // Load shared data once
    const allPolicies = await db.select().from(policies);
    const allProvisions = await db.select().from(provisions);
    const allLabels = await db.select().from(subDomainLabels);

    const results = [];
    const ids = limit ? obligation_ids.slice(0, limit) : obligation_ids;

    for (const id of ids) {
      const rows = await db.select().from(obligations).where(eq(obligations.id, id));
      if (rows.length === 0) continue;
      const obl = rows[0];
      const candidates = findCandidates(obl, allPolicies, allProvisions, allLabels);
      results.push({
        obligation: { id: obl.id, citation: obl.citation, requirement: obl.requirement },
        candidates,
      });
    }

    return Response.json({
      results,
      total_matched: results.length,
      total_policies_searched: allPolicies.length,
    });

  } catch (err) {
    console.error('Batch match error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
