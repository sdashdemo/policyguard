import { db } from '@/lib/db';
import { obligations } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import { findCandidatesHybrid } from '@/lib/matching';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const LABELS = [
  { citation: "397.403(1)(f)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC 1.010"] },
  { citation: "397.4073(1)(a)2", bucket: "gold", label_type: "single", accepted_policy_numbers: ["HR-2.001"] },
  { citation: "65D-30.0037(2)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LD-3.001"] },
  { citation: "65D-30.004(1)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LD-4.001"] },
  { citation: "65D-30.004(4)(d)", bucket: "soft", label_type: "any_of", accepted_policy_numbers: ["HR-2.011", "HR-2.001"] },
  { citation: "65D-30.004(6)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["MED-2.002"] },
  { citation: "65D-30.0041(1)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["IM 2.002"] },
  { citation: "65D-30.0042(2)(a)(2)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["MED-3.004a"] },
  { citation: "65D-30.0042(2)(b)(3)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL2.004"] },
  { citation: "65D-30.0044(1)(a)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL3.007"] },
  { citation: "65D-30.0047(11)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC 1.010"] },
  { citation: "65D-30.010(4)", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL6.007"] },
  { citation: "APR.09.02.01 EP 3", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LD 4.003"] },
  { citation: "CTS.02.02.01 EP 3", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL2.004"] },
  { citation: "CTS.02.02.05 EP 3", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL2.004"] },
  { citation: "CTS.02.02.09 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["NUR-1.018"] },
  { citation: "CTS.04.01.01 EP 10", bucket: "gold", label_type: "single", accepted_policy_numbers: ["MMP-2.001"] },
  { citation: "CTS.04.02.21 EP 2", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL4.007"] },
  { citation: "CTS.04.03.21 EP 3", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL-5.021"] },
  { citation: "CTS.06.02.03 EP 6", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL-1.005"] },
  { citation: "CTS.06.02.03 EP 7", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL-1.003"] },
  { citation: "LD.04.01.03 ESP-1 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LD-1.001"] },
  { citation: "LD.04.03.09 EP 6", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LD-3.003"] },
  { citation: "RC.01.03.01 EP 2", bucket: "gold", label_type: "single", accepted_policy_numbers: ["IM-2.017"] },
  { citation: "RI.01.01.01 EP 2", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL-5.005"] },
  { citation: "TJC EC.01.01.01 EP 3", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.016"] },
  { citation: "TJC EC.02.01.01 EP 3", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.012"] },
  { citation: "TJC EC.02.03.03 EP 1", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["EC-1.007", "EC-1.008"] },
  { citation: "TJC EC.02.03.05 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.008"] },
  { citation: "TJC EC.02.03.05 EP 14", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.008"] },
  { citation: "TJC EC.02.05.03 EP 5", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.006"] },
  { citation: "TJC EC.02.05.05 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.018"] },
  { citation: "TJC EM.16.01.01 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EM-1.006"] },
  { citation: "TJC HRM.01.04.01 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["HR-2.002"] },
  { citation: "TJC LD.03.03.01 EP 2", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LD-2.004"] },
  { citation: "TJC LS.02.01.20 EP 18", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["EC-1.008", "LS-1.001"] },
  { citation: "TJC LS.02.01.20 EP 35", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LS-1.003"] },
  { citation: "TJC LS.02.01.30 EP 9", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["LS-1.001", "EC-1.008"] },
  { citation: "TJC LS.02.01.40 EP 1", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["LS-1.001", "EC-1.008"] },
  { citation: "TJC LS.02.01.70 EP 6", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["LS-1.001", "EC-1.008"] },
  { citation: "TJC LS.04.01.30 EP 7", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LS-1.001"] },
  { citation: "TJC LS.04.02.30 EP 10", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.008"] },
  { citation: "TJC LS.04.02.30 EP 12", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["LS-1.001", "EC-1.008"] },
  { citation: "TJC LS.04.02.30 EP 17", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["LS-1.001", "EC-1.008"] },
  { citation: "TJC LS.04.02.30 EP 19", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LS-1.001"] },
  { citation: "TJC LS.04.02.30 EP 4", bucket: "gold", label_type: "any_of", accepted_policy_numbers: ["LS-1.001", "EC-1.008"] },
  { citation: "TJC LS.04.02.30 EP 8", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC-1.008"] },
  { citation: "TJC LS.05.01.10 EP 6", bucket: "gold", label_type: "single", accepted_policy_numbers: ["EC 1.010"] },
  { citation: "TJC MM.03.01.01 EP 7", bucket: "gold", label_type: "single", accepted_policy_numbers: ["MMP-3.009"] },
  { citation: "TJC MM.05.01.09 EP 2", bucket: "gold", label_type: "single", accepted_policy_numbers: ["MMP-3.009"] },
  { citation: "TJC MM.05.01.17 EP 1 ESP-1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["MMP-3.007"] },
  { citation: "TJC MM.07.01.01 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["NUR-2.003"] },
  { citation: "TJC NPSG.07.01.01 EP 1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["LAB-1.008"] },
  { citation: "TJC NPSG.15.01.01 EP 6 ESP-1", bucket: "gold", label_type: "single", accepted_policy_numbers: ["CL-2.006"] },
];

function normalizePN(pn) { return (pn || '').toLowerCase().replace(/[\s-]+/g, ''); }

export async function GET() {
  const results = [];
  let top1_hits = 0;
  let top3_hits = 0;
  let skipped = 0;

  for (const label of LABELS) {
    // Find obligation by citation
    const oblRows = await db
      .select()
      .from(obligations)
      .where(eq(obligations.citation, label.citation));

    if (oblRows.length === 0) {
      results.push({
        citation: label.citation,
        accepted_policies: label.accepted_policy_numbers,
        error: 'obligation_not_found',
        top1_policy: null,
        found_rank: null,
        top1_hit: false,
        top3_hit: false,
        signal_breakdown: null,
      });
      skipped++;
      continue;
    }

    const obl = oblRows[0];

    // Enrich with source_name (same pattern as assess route)
    const sourceResult = await db.execute(
      sql`SELECT name FROM reg_sources WHERE id = ${obl.reg_source_id}`
    );
    obl.source_name = (sourceResult.rows || sourceResult)?.[0]?.name || null;

    // Run hybrid matching
    const { candidates } = await findCandidatesHybrid(obl);

    // Check accepted policies against candidates
    const accepted = label.accepted_policy_numbers;
    const top1Policy = candidates[0]?.policy_number || null;

    // Find best rank of any accepted policy in candidates list
    const acceptedNorm = accepted.map(normalizePN);
    let found_rank = null;
    for (let i = 0; i < candidates.length; i++) {
      if (acceptedNorm.includes(normalizePN(candidates[i].policy_number))) {
        found_rank = i + 1; // 1-indexed
        break;
      }
    }

    const top1_hit = found_rank === 1;
    const top3_hit = found_rank !== null && found_rank <= 3;

    if (top1_hit) top1_hits++;
    if (top3_hit) top3_hits++;

    results.push({
      citation: label.citation,
      accepted_policies: accepted,
      top1_policy: top1Policy,
      found_rank,
      top1_hit,
      top3_hit,
      signal_breakdown: candidates[0]?.signal_breakdown || null,
    });
  }

  const evaluated = LABELS.length - skipped;

  return Response.json({
    total: LABELS.length,
    evaluated,
    skipped,
    top1_hits,
    top3_hits,
    top1_rate: evaluated > 0 ? +(top1_hits / evaluated).toFixed(4) : null,
    top3_rate: evaluated > 0 ? +(top3_hits / evaluated).toFixed(4) : null,
    details: results,
  });
}
