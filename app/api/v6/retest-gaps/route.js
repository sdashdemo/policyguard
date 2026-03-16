// app/api/v6/retest-gaps/route.js
//
// Temporary route: re-assesses the 40 audited GAP rows with the updated prompt.
// Hit GET /api/v6/retest-gaps to run. Returns JSON diff report.
// DELETE THIS ROUTE after validation is complete.

import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/lib/db';
import { sql } from 'drizzle-orm';
import { ASSESS_PROMPT } from '@/lib/prompts';
import { renderFacilityContext, buildFacilityContextString } from '@/lib/facility-attributes';
import { generateQueryEmbedding } from '@/lib/embeddings';
import { parseJSON } from '@/lib/parse';

export const dynamic = 'force-dynamic';
export const maxDuration = 300; // 5 minutes — needs time for 40 LLM calls

const MODEL_ID = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-20250514';
const FACILITY_ABBR = 'ORC';

// The run to compare against
const RUN_ID = 'mm548ato_1bf5r3gy';

// The 40 reviewed GAP audit rows with human labels
const AUDIT_ROWS = [
  { row: 1, citation: 'CTS.02.02.05 EP 4', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 2, citation: 'TJC MM.05.01.07 EP 2', label: 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY' },
  { row: 3, citation: 'TJC LS.04.01.20 EP 1', label: 'TRUE_GAP' },
  { row: 4, citation: 'TJC NPSG.15.01.01 EP 7', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 5, citation: 'RC.01.05.01 EP 8', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 6, citation: 'RC.01.02.01 EP 5', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 7, citation: 'TJC LS.01.02.01 ESP-1.9', label: 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY' },
  { row: 8, citation: 'LD.03.09.01 EP 7', label: 'TRUE_GAP' },
  { row: 9, citation: 'LD.04.02.01 EP 5', label: 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY' },
  { row: 10, citation: 'TJC LS.01.01.01 ESP-1.3', label: 'EVIDENCE_PACKET_ISSUE' },
  { row: 11, citation: 'APR.09.01.01 EP 1', label: 'TRUE_GAP' },
  { row: 12, citation: 'TJC LS.01.02.01 ESP-1.6', label: 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY' },
  { row: 13, citation: 'RC.01.01.01 EP 1', label: 'EVIDENCE_PACKET_ISSUE' },
  { row: 14, citation: 'TJC LD.03.06.01 EP 2', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 15, citation: 'TJC RI.01.03.05 EP 3', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 16, citation: 'CTS.05.05.07 EP 1', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 17, citation: 'CTS.04.01.03 EP 3', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 18, citation: 'TJC RI.01.02.01 EP 4', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 19, citation: 'TJC MM.04.01.01 ESP-1', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 20, citation: 'APR.06.01.01 EP 1', label: 'EVIDENCE_PACKET_ISSUE' },
  { row: 21, citation: 'CTS.04.02.19 EP 1', label: 'AMBIGUOUS_STANDARD' },
  { row: 22, citation: 'CTS.05.05.11 EP 2', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 23, citation: 'TJC EM.12.02.09 EP 2', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 24, citation: 'TJC LS.04.01.30 EP 3', label: 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY' },
  { row: 25, citation: 'TJC LS.05.01.35 EP 3', label: 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY' },
  { row: 26, citation: 'CTS.04.03.31 EP 1', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 27, citation: 'TJC BH Definition - Hazard vulnerability analysis', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 28, citation: 'TJC BH Definitions - individualized behavioral contingencies', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 29, citation: 'TJC CTS.01.03.01 EP 1', label: 'GAP_SHOULD_BE_PARTIAL' },
  { row: 30, citation: 'TJC RI.01.06.05 EP 27', label: 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY' },
  { row: 31, citation: '65E-4.016(13)(b)', label: 'GAP_SHOULD_BE_NOT_APPLICABLE', dup: 1 },
  { row: 32, citation: '65E-4.016(13)(b)', label: 'GAP_SHOULD_BE_NOT_APPLICABLE', dup: 2 },
  { row: 33, citation: '65E-4.016(15)(b)1', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 34, citation: '65E-4.016(17)(b)3.j.(III)', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 35, citation: '65D-30.004(6)(a)', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 36, citation: '65D-30.004(3)(e)', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
  { row: 37, citation: '65D-30.004(4)(c)', label: 'AMBIGUOUS_STANDARD' },
  { row: 38, citation: '65D-30.004(6)(f)', label: 'EVIDENCE_PACKET_ISSUE' },
  { row: 39, citation: '65D-30.0042(2)(a)(5)', label: 'EVIDENCE_PACKET_ISSUE' },
  { row: 40, citation: '65D-30.004(6)(a)(2)', label: 'GAP_SHOULD_BE_NOT_APPLICABLE' },
];

export async function GET(req) {
  const results = [];
  const errors = [];

  try {
    // Load facility
    const facilityResult = await db.execute(sql`
      SELECT * FROM facility_profiles WHERE abbreviation = ${FACILITY_ABBR} LIMIT 1
    `);
    const facility = (facilityResult.rows || facilityResult)?.[0];
    if (!facility) return Response.json({ error: 'Facility not found' }, { status: 400 });

    // Merge legacy attributes
    const attrs = facility.attributes || {};
    if (attrs.prohibits_restraint === undefined && facility.prohibits_restraint !== undefined)
      attrs.prohibits_restraint = facility.prohibits_restraint;
    if (attrs.operates_otp === undefined && facility.operates_otp !== undefined)
      attrs.operates_otp = facility.operates_otp;
    if (attrs.smoking_in_buildings === undefined && facility.smoking_in_buildings_allowed !== undefined)
      attrs.smoking_in_buildings = facility.smoking_in_buildings_allowed;
    if (attrs.patient_work_program === undefined && facility.allows_patient_work_program !== undefined)
      attrs.patient_work_program = facility.allows_patient_work_program;
    facility.attributes = attrs;

    // Load all policies + provisions once
    const policiesResult = await db.execute(sql`
      SELECT id, policy_number, title, domain, sub_domain, dcf_citations, tjc_citations
      FROM policies WHERE status = 'active' OR status IS NULL
    `);
    const policies = policiesResult.rows || policiesResult;

    const provsResult = await db.execute(sql`SELECT id, policy_id, text, section, source_citation FROM provisions`);
    const provisions = provsResult.rows || provsResult;

    const provsByPolicy = {};
    for (const prov of provisions) {
      if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
      provsByPolicy[prov.policy_id].push(prov);
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    for (const auditRow of AUDIT_ROWS) {
      const { row, citation, label, dup } = auditRow;

      try {
        // Look up obligation + old assessment
        const oblResult = await db.execute(sql`
          SELECT o.id, o.citation, o.requirement, o.reg_source_id, o.loc_applicability,
                 o.risk_tier, o.topics,
                 ca.status as old_status, ca.confidence as old_confidence,
                 ca.reasoning as old_reasoning,
                 rs.name as source_name
          FROM obligations o
          JOIN coverage_assessments ca ON ca.obligation_id = o.id
          JOIN reg_sources rs ON rs.id = o.reg_source_id
          WHERE o.citation = ${citation}
            AND ca.map_run_id = ${RUN_ID}
            AND ca.status = 'GAP'
          ORDER BY o.id
          LIMIT 1 ${dup ? sql`OFFSET ${(dup - 1)}` : sql``}
        `);

        const obl = (oblResult.rows || oblResult)?.[0];
        if (!obl) {
          results.push({ row, citation, label, old_status: 'NOT_FOUND', new_status: 'SKIP', changed: false });
          continue;
        }

        // Vector search for candidates
        const queryText = `${obl.citation}: ${obl.requirement}`;
        const embedding = await generateQueryEmbedding(queryText);
        const vectorStr = `[${embedding.join(',')}]`;

        const vectorResults = await db.execute(sql`
          SELECT p.policy_id, p.id as provision_id, p.text as provision_text, p.section,
                 1 - (p.embedding <=> ${vectorStr}::vector) as similarity
          FROM provisions p
          WHERE p.embedding IS NOT NULL
          ORDER BY p.embedding <=> ${vectorStr}::vector
          LIMIT 30
        `);

        const vecRows = vectorResults.rows || vectorResults || [];

        // Group by policy
        const policyBestSim = {};
        const provSimMap = {};
        for (const vr of vecRows) {
          provSimMap[vr.provision_id] = Number(vr.similarity);
          if (!policyBestSim[vr.policy_id] || Number(vr.similarity) > policyBestSim[vr.policy_id]) {
            policyBestSim[vr.policy_id] = Number(vr.similarity);
          }
        }

        // Top 12 candidates
        const sorted = Object.entries(policyBestSim)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 12);

        const candidates = [];
        for (const [policyId, bestSim] of sorted) {
          const policy = policies.find(p => p.id === policyId);
          if (!policy) continue;
          const policyProvs = (provsByPolicy[policyId] || [])
            .map(p => ({ ...p, _sim: provSimMap[p.id] || 0 }))
            .sort((a, b) => b._sim - a._sim)
            .slice(0, 8);
          candidates.push({
            policy_number: policy.policy_number,
            title: policy.title,
            provisions: policyProvs,
          });
        }

        if (candidates.length === 0) {
          results.push({ row, citation, label, old_status: obl.old_status, new_status: 'GAP', changed: false, note: 'no candidates' });
          continue;
        }

        // Call Claude with the UPDATED prompt
        const promptContent = ASSESS_PROMPT(obl, candidates, facility);

        const message = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 1536,
          messages: [{ role: 'user', content: promptContent }],
        });

        const parsed = parseJSON(message.content[0].text);
        const newStatus = parsed.status || 'PARSE_ERROR';
        const changed = newStatus !== obl.old_status;

        results.push({
          row,
          citation,
          label,
          old_status: obl.old_status,
          new_status: newStatus,
          new_confidence: parsed.confidence || 'low',
          changed,
          direction: changed ? `GAP → ${newStatus}` : 'unchanged',
          reasoning: (parsed.reasoning || '').slice(0, 300),
          gap_detail: (parsed.gap_detail || '').slice(0, 200),
          covering_policy: parsed.covering_policy_number || null,
        });

        // Small delay for rate limits
        await new Promise(r => setTimeout(r, 1200));

      } catch (rowErr) {
        errors.push({ row, citation, error: rowErr.message });
        results.push({ row, citation, label, old_status: 'ERROR', new_status: 'ERROR', changed: false });
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // ── Build summary ──
    const changed = results.filter(r => r.changed);
    const buckets = {};
    for (const r of changed) {
      const key = `GAP → ${r.new_status}`;
      if (!buckets[key]) buckets[key] = [];
      buckets[key].push({ row: r.row, citation: r.citation, label: r.label, confidence: r.new_confidence });
    }

    // Validate against audit labels
    let trueGapHeld = 0, trueGapLost = 0;
    let shouldBePartialFixed = 0, shouldBePartialStuck = 0;
    let shouldBeNAFixed = 0, shouldBeNAStuck = 0;
    let packetFixed = 0, packetStuck = 0;
    let neighborFixed = 0, neighborStuck = 0;
    let newFalseCovered = 0;

    for (const r of results) {
      if (r.new_status === 'SKIP' || r.new_status === 'ERROR') continue;
      switch (r.label) {
        case 'TRUE_GAP':
          if (r.new_status === 'GAP') trueGapHeld++; else trueGapLost++;
          break;
        case 'GAP_SHOULD_BE_PARTIAL':
          if (r.new_status !== 'GAP') shouldBePartialFixed++; else shouldBePartialStuck++;
          break;
        case 'GAP_SHOULD_BE_NOT_APPLICABLE':
          if (r.new_status !== 'GAP') shouldBeNAFixed++; else shouldBeNAStuck++;
          break;
        case 'EVIDENCE_PACKET_ISSUE':
          if (r.new_status !== 'GAP') packetFixed++; else packetStuck++;
          break;
        case 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY':
          if (r.new_status !== 'GAP') neighborFixed++; else neighborStuck++;
          break;
      }
      if (r.new_status === 'COVERED' && r.label === 'TRUE_GAP') newFalseCovered++;
    }

    const promptGate = {
      shouldBePartial: `${shouldBePartialFixed}/9 (need ≥7)`,
      shouldBePartialPassed: shouldBePartialFixed >= 7,
      trueGapRegressions: `${trueGapLost} (need 0)`,
      trueGapPassed: trueGapLost === 0,
      falseCovered: `${newFalseCovered} (need ≤1)`,
      falseCoveredPassed: newFalseCovered <= 1,
      PHASE_B_GATE: (shouldBePartialFixed >= 7 && trueGapLost === 0 && newFalseCovered <= 1) ? 'PASSED' : 'FAILED',
    };

    return Response.json({
      summary: {
        total: results.length,
        changed: changed.length,
        unchanged: results.filter(r => !r.changed && r.new_status !== 'SKIP' && r.new_status !== 'ERROR').length,
        skipped: results.filter(r => r.new_status === 'SKIP' || r.new_status === 'ERROR').length,
      },
      buckets,
      validation: {
        trueGapHeld: `${trueGapHeld}/3`,
        trueGapLost,
        shouldBePartialFixed: `${shouldBePartialFixed}/9`,
        shouldBePartialStuck,
        shouldBeNAFixed: `${shouldBeNAFixed}/14`,
        shouldBeNAStuck,
        packetFixed: `${packetFixed}/5`,
        packetStuck,
        neighborFixed: `${neighborFixed}/7`,
        neighborStuck,
        newFalseCovered,
      },
      promptGate,
      results,
      errors,
    });

  } catch (e) {
    return Response.json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}
