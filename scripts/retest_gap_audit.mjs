#!/usr/bin/env node

/**
 * scripts/retest_gap_audit.mjs
 *
 * Re-assesses the 40 reviewed GAP audit rows using the updated prompt (v8),
 * compares old vs new status, and produces a diff report.
 *
 * Usage:
 *   node scripts/retest_gap_audit.mjs
 *
 * Requires .env.local with DATABASE_URL, ANTHROPIC_API_KEY, VOYAGE_API_KEY
 *
 * Does NOT write to the database. Read-only except for its own output file.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import postgres from 'postgres';
import { readFileSync, writeFileSync } from 'fs';

// ── Config ──────────────────────────────────────────────────────────────────
const DB_URL = process.env.DATABASE_URL;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const MODEL_ID = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-20250514';

// The run ID from the GAP audit (March 11 run with 1,596 obligations)
const RUN_ID = 'mm548ato_1bf5r3gy';

// Facility: ORC (the intended facility for this run)
// Will be looked up by abbreviation
const FACILITY_ABBR = 'ORC';

if (!DB_URL || !ANTHROPIC_KEY) {
  console.error('Missing DATABASE_URL or ANTHROPIC_API_KEY in environment');
  process.exit(1);
}

const sql = postgres(DB_URL, { prepare: false });
const client = new Anthropic({ apiKey: ANTHROPIC_KEY });

// ── The 40 reviewed citations with their audit labels ───────────────────────
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

// ── Dynamically import the assess prompt and facility context ────────────────
// These are ESM modules in the repo. We import them directly.
// If running from repo root: node scripts/retest_gap_audit.mjs

let ASSESS_PROMPT, renderFacilityContext;
try {
  const prompts = await import('../lib/prompts.js');
  ASSESS_PROMPT = prompts.ASSESS_PROMPT;
  const fa = await import('../lib/facility-attributes.js');
  renderFacilityContext = fa.renderFacilityContext;
} catch (e) {
  console.error('Could not import lib modules. Run this script from the repo root.');
  console.error(e.message);
  process.exit(1);
}

// ── Voyage embedding helper (for matching) ──────────────────────────────────
async function generateQueryEmbedding(text) {
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${VOYAGE_KEY}`,
    },
    body: JSON.stringify({ model: 'voyage-law-2', input: [text], input_type: 'query' }),
  });
  if (!res.ok) throw new Error(`Voyage error: ${res.status}`);
  const data = await res.json();
  return data.data[0].embedding;
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('=== PolicyGuard GAP Audit Re-Test ===');
  console.log(`Model: ${MODEL_ID}`);
  console.log(`Run: ${RUN_ID}`);
  console.log(`Rows: ${AUDIT_ROWS.length}\n`);

  // Load facility profile
  const [facility] = await sql`
    SELECT * FROM facility_profiles WHERE abbreviation = ${FACILITY_ABBR}
  `;
  if (!facility) {
    console.error(`Facility ${FACILITY_ABBR} not found`);
    process.exit(1);
  }

  // Merge legacy attributes into JSONB (same as assess route)
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

  console.log(`Facility: ${facility.name} (${facility.abbreviation})`);
  console.log(`LOCs: ${JSON.stringify(facility.levels_of_care)}\n`);

  // Load all policies and provisions once
  const policies = await sql`SELECT * FROM policies WHERE status = 'active' OR status IS NULL`;
  const provisions = await sql`SELECT * FROM provisions`;

  const provsByPolicy = {};
  for (const prov of provisions) {
    if (!provsByPolicy[prov.policy_id]) provsByPolicy[prov.policy_id] = [];
    provsByPolicy[prov.policy_id].push(prov);
  }

  const results = [];

  for (const auditRow of AUDIT_ROWS) {
    const { row, citation, label, dup } = auditRow;
    process.stdout.write(`Row ${row} (${citation})... `);

    // Look up obligation + its old assessment from the run
    const oblQuery = dup
      ? await sql`
          SELECT o.*, ca.status as old_status, ca.confidence as old_confidence,
                 ca.reasoning as old_reasoning, ca.gap_detail as old_gap_detail,
                 ca.id as assessment_id, rs.name as source_name
          FROM obligations o
          JOIN coverage_assessments ca ON ca.obligation_id = o.id
          JOIN reg_sources rs ON rs.id = o.reg_source_id
          WHERE o.citation = ${citation}
            AND ca.map_run_id = ${RUN_ID}
            AND ca.status = 'GAP'
          ORDER BY o.id
          LIMIT 1 OFFSET ${(dup || 1) - 1}
        `
      : await sql`
          SELECT o.*, ca.status as old_status, ca.confidence as old_confidence,
                 ca.reasoning as old_reasoning, ca.gap_detail as old_gap_detail,
                 ca.id as assessment_id, rs.name as source_name
          FROM obligations o
          JOIN coverage_assessments ca ON ca.obligation_id = o.id
          JOIN reg_sources rs ON rs.id = o.reg_source_id
          WHERE o.citation = ${citation}
            AND ca.map_run_id = ${RUN_ID}
            AND ca.status = 'GAP'
          ORDER BY o.id
          LIMIT 1
        `;

    if (oblQuery.length === 0) {
      console.log('SKIP — obligation not found in run');
      results.push({ row, citation, label, old_status: 'NOT_FOUND', new_status: 'SKIP', changed: false });
      continue;
    }

    const obl = oblQuery[0];

    // Find candidates using vector search (simplified — just top 20 by similarity)
    let candidates = [];
    try {
      const queryText = `${obl.citation}: ${obl.requirement}`;
      const embedding = await generateQueryEmbedding(queryText);
      const vectorStr = `[${embedding.join(',')}]`;

      const vectorResults = await sql`
        SELECT p.policy_id, p.id as provision_id, p.text as provision_text, p.section,
               1 - (p.embedding <=> ${vectorStr}::vector) as similarity
        FROM provisions p
        WHERE p.embedding IS NOT NULL
        ORDER BY p.embedding <=> ${vectorStr}::vector
        LIMIT 30
      `;

      // Group by policy, keep best sim
      const policyBestSim = {};
      const provSimMap = {};
      for (const vr of vectorResults) {
        provSimMap[vr.provision_id] = vr.similarity;
        if (!policyBestSim[vr.policy_id] || vr.similarity > policyBestSim[vr.policy_id]) {
          policyBestSim[vr.policy_id] = vr.similarity;
        }
      }

      // Build candidate context (top 12 by best provision similarity)
      const sorted = Object.entries(policyBestSim)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 12);

      for (const [policyId, bestSim] of sorted) {
        const policy = policies.find(p => p.id === policyId);
        if (!policy) continue;
        const policyProvs = (provsByPolicy[policyId] || [])
          .map(p => ({
            ...p,
            _sim: provSimMap[p.id] || 0,
          }))
          .sort((a, b) => b._sim - a._sim)
          .slice(0, 8); // cap per policy

        candidates.push({
          policy_number: policy.policy_number,
          title: policy.title,
          provisions: policyProvs,
        });
      }
    } catch (e) {
      console.log(`VECTOR_ERROR: ${e.message}`);
      results.push({ row, citation, label, old_status: obl.old_status, new_status: 'VECTOR_ERROR', changed: false });
      continue;
    }

    if (candidates.length === 0) {
      console.log('NO_CANDIDATES');
      results.push({ row, citation, label, old_status: obl.old_status, new_status: 'GAP', changed: false, note: 'no candidates' });
      continue;
    }

    // Build the prompt using the UPDATED ASSESS_PROMPT from lib/prompts.js
    const promptContent = ASSESS_PROMPT(obl, candidates, facility);

    // Call Claude
    let newStatus = 'ERROR';
    let newConfidence = 'low';
    let newReasoning = '';
    let parsed = null;

    try {
      const message = await client.messages.create({
        model: MODEL_ID,
        max_tokens: 1536,
        messages: [{ role: 'user', content: promptContent }],
      });

      const rawText = message.content[0].text;

      // Parse JSON (strip fences if present)
      const cleaned = rawText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      parsed = JSON.parse(cleaned);
      newStatus = parsed.status || 'PARSE_ERROR';
      newConfidence = parsed.confidence || 'low';
      newReasoning = parsed.reasoning || '';
    } catch (e) {
      console.log(`LLM_ERROR: ${e.message}`);
      results.push({ row, citation, label, old_status: obl.old_status, new_status: 'LLM_ERROR', changed: false });
      // Rate limit backoff
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    const changed = newStatus !== obl.old_status;
    const direction = changed ? `${obl.old_status} → ${newStatus}` : 'unchanged';

    console.log(`${direction} (${newConfidence}) ${changed ? '★' : ''}`);

    results.push({
      row,
      citation,
      label,
      old_status: obl.old_status,
      new_status: newStatus,
      new_confidence: newConfidence,
      changed,
      direction,
      reasoning: newReasoning.slice(0, 200),
      gap_detail: (parsed?.gap_detail || '').slice(0, 200),
      covering_policy: parsed?.covering_policy_number || null,
    });

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 1500));
  }

  // ── Summary Report ──────────────────────────────────────────────────────
  console.log('\n\n' + '═'.repeat(80));
  console.log('GAP AUDIT RE-TEST RESULTS');
  console.log('═'.repeat(80));

  const changed = results.filter(r => r.changed);
  const unchanged = results.filter(r => !r.changed && r.new_status !== 'SKIP');
  const skipped = results.filter(r => r.new_status === 'SKIP' || r.new_status === 'LLM_ERROR' || r.new_status === 'VECTOR_ERROR');

  console.log(`\nTotal: ${results.length} | Changed: ${changed.length} | Unchanged: ${unchanged.length} | Skipped: ${skipped.length}`);

  // Bucket the changes
  const buckets = {};
  for (const r of changed) {
    const key = `${r.old_status} → ${r.new_status}`;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(r);
  }

  console.log('\n── Status Changes ──');
  for (const [bucket, rows] of Object.entries(buckets).sort()) {
    console.log(`\n  ${bucket}: ${rows.length}`);
    for (const r of rows) {
      console.log(`    Row ${r.row}: ${r.citation} [audit: ${r.label}] → ${r.new_status} (${r.new_confidence})`);
      if (r.covering_policy) console.log(`      matched: ${r.covering_policy}`);
    }
  }

  // ── Validation against audit labels ──────────────────────────────────────
  console.log('\n── Validation vs Audit Labels ──');

  let trueGapHeld = 0;
  let trueGapLost = 0;
  let shouldBePartialFixed = 0;
  let shouldBePartialStuck = 0;
  let shouldBeNAFixed = 0;
  let shouldBeNAStuck = 0;
  let packetFixed = 0;
  let packetStuck = 0;
  let neighborFixed = 0;
  let neighborStuck = 0;
  let newFalseCovered = 0;
  let ambiguousChanged = 0;

  for (const r of results) {
    if (r.new_status === 'SKIP' || r.new_status === 'LLM_ERROR' || r.new_status === 'VECTOR_ERROR') continue;

    switch (r.label) {
      case 'TRUE_GAP':
        if (r.new_status === 'GAP') trueGapHeld++;
        else trueGapLost++;
        break;
      case 'GAP_SHOULD_BE_PARTIAL':
        if (r.new_status !== 'GAP') shouldBePartialFixed++;
        else shouldBePartialStuck++;
        break;
      case 'GAP_SHOULD_BE_NOT_APPLICABLE':
        if (r.new_status === 'NOT_APPLICABLE') shouldBeNAFixed++;
        else if (r.new_status !== 'GAP') shouldBeNAFixed++; // moved off GAP at least
        else shouldBeNAStuck++;
        break;
      case 'EVIDENCE_PACKET_ISSUE':
        if (r.new_status !== 'GAP') packetFixed++;
        else packetStuck++;
        break;
      case 'GAP_BUT_CITATION_TO_NEIGHBOR_POLICY':
        if (r.new_status !== 'GAP') neighborFixed++;
        else neighborStuck++;
        break;
      case 'AMBIGUOUS_STANDARD':
        if (r.changed) ambiguousChanged++;
        break;
    }

    // Check for new false COVERED (dangerous overcall)
    if (r.new_status === 'COVERED' && r.label !== 'GAP_SHOULD_BE_PARTIAL') {
      // COVERED is only expected from some PARTIAL rows; elsewhere it's suspicious
      newFalseCovered++;
    }
  }

  console.log(`
  TRUE_GAP held as GAP:          ${trueGapHeld}/3 ${trueGapHeld === 3 ? '✓' : '⚠ REGRESSION'}
  TRUE_GAP lost (regression!):   ${trueGapLost}

  SHOULD_BE_PARTIAL fixed:       ${shouldBePartialFixed}/9
  SHOULD_BE_PARTIAL stuck:       ${shouldBePartialStuck}

  SHOULD_BE_N/A fixed:           ${shouldBeNAFixed}/14
  SHOULD_BE_N/A stuck:           ${shouldBeNAStuck}

  EVIDENCE_PACKET fixed:         ${packetFixed}/5
  EVIDENCE_PACKET stuck:         ${packetStuck}

  NEIGHBOR_POLICY fixed:         ${neighborFixed}/7
  NEIGHBOR_POLICY stuck:         ${neighborStuck}

  New false COVERED:             ${newFalseCovered} ${newFalseCovered <= 1 ? '✓' : '⚠ OVERCALL RISK'}
  AMBIGUOUS changed:             ${ambiguousChanged}/2 (informational)
  `);

  // ── GPT Phase B gate check ──────────────────────────────────────────────
  console.log('── Phase B (Prompt) Gate Check ──');
  const promptGatePassed =
    shouldBePartialFixed >= 7 &&
    trueGapLost === 0 &&
    newFalseCovered <= 1;

  console.log(`  SHOULD_BE_PARTIAL ≥ 7 fixed: ${shouldBePartialFixed >= 7 ? 'PASS' : 'FAIL'} (${shouldBePartialFixed}/9)`);
  console.log(`  TRUE_GAP regressions = 0:    ${trueGapLost === 0 ? 'PASS' : 'FAIL'} (${trueGapLost})`);
  console.log(`  False COVERED ≤ 1:           ${newFalseCovered <= 1 ? 'PASS' : 'FAIL'} (${newFalseCovered})`);
  console.log(`\n  PHASE B GATE: ${promptGatePassed ? '✅ PASSED' : '❌ FAILED'}`);

  // ── Write full results to JSON ──────────────────────────────────────────
  const outputPath = 'scripts/retest_gap_audit_results.json';
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to ${outputPath}`);

  await sql.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
