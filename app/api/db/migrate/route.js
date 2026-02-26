import { db } from '@/lib/db';
import { appState, policies, provisions, regSources as regSourcesTable, obligations, facilityProfiles } from '@/lib/schema';
import { eq, and, sql } from 'drizzle-orm';

export const maxDuration = 120;

const ORG_ID = 'ars';

const SUB_DOMAIN_MAP = {
  CL1: 'Admissions/Discharge/Transfers', CL2: 'Assessment/Evaluation',
  CL3: 'Staff/Documentation/Operations', CL4: 'Daily Operations/Services',
  CL5: 'Rights/Consent/Compliance', CL6: 'Level of Care Programs', CL7: 'Reporting',
  MED1: 'General Medical', MED2: 'Medical Staff/Protocols', MED3: 'Clinical Procedures',
  NUR1: 'Nursing Administration', NUR2: 'Nursing Procedures',
  MMP1: 'Pharmacy Governance', MMP2: 'Medication Ordering', MMP3: 'Medication Storage/Handling',
  HR1: 'Employment/Administration', HR2: 'Staff Development/Credentialing',
  IC: 'Infection Control', EC: 'Environment of Care', EM: 'Emergency Management',
  LS: 'Life Safety', IM: 'Information Management', FIN: 'Financial',
  LD: 'Leadership/Governance', PI: 'Performance Improvement', UR: 'Utilization Review', LAB: 'Laboratory',
};

function parsePolicyNumber(policyNumber) {
  if (!policyNumber) return { sub_domain: null, sub_domain_label: null };
  const normalized = policyNumber.replace(/[\s-]+/g, '').toUpperCase();
  const match = normalized.match(/^([A-Z]+)(\d+)\.(\d+[A-Z]?)$/);
  if (!match) return { sub_domain: null, sub_domain_label: null };
  const sub_domain = `${match[1]}${match[2]}`;
  return { sub_domain, sub_domain_label: SUB_DOMAIN_MAP[sub_domain] || null };
}

// Deterministic ID from natural key — same input always gives same ID
function stableId(prefix, ...parts) {
  const key = parts.map(p => String(p || '').trim().toLowerCase().replace(/[\s.]+/g, '_')).join('__');
  // Simple hash to keep IDs short
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const chr = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return `${prefix}_${Math.abs(hash).toString(36)}`;
}

function extractKeywords(text) {
  if (!text) return [];
  const lower = text.toLowerCase().replace(/-/g, '');
  const terms = [
    'assessment', 'biopsychosocial', 'psychiatric', 'evaluation', 'screening',
    'treatment plan', 'treatment planning', 'individualized',
    'discharge', 'discharge plan', 'aftercare', 'transition', 'continuity',
    'consent', 'informed consent', 'voluntary', 'involuntary',
    'confidential', 'hipaa', '42 cfr', 'privacy', 'release of information',
    'medication', 'prescri', 'controlled substance', 'narcotic', 'formulary',
    'restraint', 'seclusion', 'grievance', 'complaint', 'patient rights', 'rights',
    'abuse', 'neglect', 'reporting', 'infection', 'tuberculosis', 'bloodborne', 'exposure',
    'credentialing', 'privileging', 'scope of practice',
    'training', 'competency', 'orientation',
    'documentation', 'clinical record', 'medical record', 'chart',
    'detox', 'withdrawal', 'ciwa', 'cows',
    'group therapy', 'individual therapy', 'counseling',
    'mat', 'buprenorphine', 'methadone', 'naloxone', 'narcan',
    'safety plan', 'suicide', 'homicidal', 'risk',
    'emergency', 'disaster', 'evacuation',
    'quality', 'performance improvement', 'outcome',
  ];
  return terms.filter(term => lower.includes(term));
}

export async function POST(req) {
  try {
    const body = await req.json();
    const results = { appState: 0, policies: 0, provisions: 0, regSources: 0, obligations: 0, facility: 0, skipped: 0 };

    // Step 1: Write raw blobs to app_state
    const stateKeys = ['index', 'maps', 'rewrites', 'profile', 'customDomains', 'regSources', 'overrides', 'mapState'];
    for (const key of stateKeys) {
      if (body[key] !== undefined) {
        await db.insert(appState)
          .values({ key, org_id: ORG_ID, value: body[key], updated_at: new Date() })
          .onConflictDoUpdate({ target: [appState.key], set: { value: body[key], updated_at: new Date() } });
        results.appState++;
      }
    }

    // Step 2: Create facility profile
    if (body.profile) {
      const p = body.profile;
      await db.insert(facilityProfiles)
        .values({
          id: 'facility_orc', org_id: ORG_ID,
          name: p.facilityName || 'Orlando Recovery Center', state: p.state || 'FL',
          abbreviation: 'ORC', levels_of_care: p.levelsOfCare || [],
          services_offered: p.servicesOffered || [], services_excluded: [],
          accreditations: p.accreditations || [], prohibits_restraint: p.prohibitsRestraint ?? true,
          bed_count: p.bedCount || null, updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: [facilityProfiles.id],
          set: { name: p.facilityName || 'Orlando Recovery Center', state: p.state || 'FL',
            levels_of_care: p.levelsOfCare || [], services_offered: p.servicesOffered || [],
            prohibits_restraint: p.prohibitsRestraint ?? true, updated_at: new Date() },
        });
      results.facility++;
    }

    // Step 3: Normalize indexResults -> policies + provisions
    if (body.index && Array.isArray(body.index)) {
      for (const idx of body.index) {
        const policyId = stableId('pol', ORG_ID, idx.policy_id);
        const { sub_domain, sub_domain_label } = parsePolicyNumber(idx.policy_id);

        await db.insert(policies)
          .values({
            id: policyId, org_id: ORG_ID, facility_id: 'facility_orc',
            policy_number: idx.policy_id, title: idx.title || 'Untitled',
            source_file: idx.source_file, domain: idx.domain, sub_domain, sub_domain_label,
            facility_name: idx.facility_name, effective_date: idx.effective_date,
            revision_dates: idx.revision_dates, purpose: idx.purpose, summary: idx.summary,
            dcf_citations: idx.dcf_citations || [], tjc_citations: idx.tjc_citations || [],
            section_headings: idx.section_headings || [], topics_covered: idx.topics_covered || [],
            header_issues: idx.header_issues || [], full_text: idx.full_text || null,
            indexed_at: new Date(),
          })
          .onConflictDoUpdate({
            target: [policies.id],
            set: { title: idx.title || 'Untitled', domain: idx.domain, sub_domain, sub_domain_label,
              dcf_citations: idx.dcf_citations || [], tjc_citations: idx.tjc_citations || [],
              topics_covered: idx.topics_covered || [], updated_at: new Date() },
          });
        results.policies++;

        // v6 FIX: Removed delete-before-insert. onConflictDoUpdate handles re-runs.
        if (idx.provisions && Array.isArray(idx.provisions)) {
          for (let pi = 0; pi < idx.provisions.length; pi++) {
            const prov = idx.provisions[pi];
            const provId = stableId('prv', policyId, pi, (prov.text || '').slice(0, 60));
            await db.insert(provisions)
              .values({
                id: provId, policy_id: policyId, text: prov.text,
                section: prov.section || null, source_citation: prov.source || null,
                keywords: extractKeywords(prov.text),
              })
              .onConflictDoUpdate({
                target: [provisions.id],
                set: { text: prov.text, section: prov.section || null, keywords: extractKeywords(prov.text) },
              });
            results.provisions++;
          }
        }
      }
    }

    // Step 4: Normalize regSources -> reg_sources + obligations
    if (body.regSources && Array.isArray(body.regSources)) {
      for (const src of body.regSources) {
        const sourceId = stableId('src', src.name);

        await db.insert(regSourcesTable)
          .values({
            id: sourceId, name: src.name, state: src.state || null,
            source_type: src.sourceType || 'state_reg', filename: src.filename || null,
            full_text: src.text || null,
            extracted_at: src.extractedAt ? new Date(src.extractedAt) : null,
          })
          .onConflictDoUpdate({
            target: [regSourcesTable.id],
            set: { name: src.name, full_text: src.text || null,
              extracted_at: src.extractedAt ? new Date(src.extractedAt) : null },
          });
        results.regSources++;

        // v6 FIX: Removed delete-before-insert that caused chunking bug.
        // onConflictDoUpdate handles re-runs safely with stable IDs.
        if (src.extractedReqs && Array.isArray(src.extractedReqs)) {
          for (let ri = 0; ri < src.extractedReqs.length; ri++) {
            const r = src.extractedReqs[ri];
            const oblId = stableId('obl', sourceId, r.citation, (r.requirement || '').slice(0, 60));
            await db.insert(obligations)
              .values({
                id: oblId, reg_source_id: sourceId,
                citation: r.citation || 'Unknown', requirement: r.requirement,
                source_type: r.source_type || src.sourceType || 'state_reg',
                topics: r.topic ? [r.topic] : [],
                responsible_party: r.responsible_party || null,
                timeframe: r.timeframe || null,
                documentation_required: r.documentation || null,
              })
              .onConflictDoUpdate({
                target: [obligations.id],
                set: { requirement: r.requirement, topics: r.topic ? [r.topic] : [] },
              });
            results.obligations++;
          }
        }
      }
    }

    return Response.json({
      ok: true, results,
      message: `Migrated: ${results.appState} state keys, ${results.policies} policies, ${results.provisions} provisions, ${results.regSources} reg sources, ${results.obligations} obligations`,
    });

  } catch (err) {
    console.error('Migration error:', err);
    return Response.json({ error: err.message, stack: err.stack }, { status: 500 });
  }
}
