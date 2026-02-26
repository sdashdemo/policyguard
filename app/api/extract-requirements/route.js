import Anthropic from '@anthropic-ai/sdk';

export const maxDuration = 120;

const EXTRACT_PROMPT = (domain, sourceName, sourceText, facilityProfile) => {
  // Build exclusion instructions from facility profile
  let exclusions = '';
  if (facilityProfile) {
    const excluded = [];
    if (!facilityProfile.servicesOffered?.includes('methadone')) {
      excluded.push('methadone-specific OTP requirements (buprenorphine MAT requirements ARE applicable)');
    }
    if (!facilityProfile.servicesOffered?.includes('juvenile')) {
      excluded.push('juvenile justice services requirements');
    }
    if (!facilityProfile.servicesOffered?.includes('children')) {
      excluded.push('child welfare or pediatric-specific requirements');
    }
    if (facilityProfile.prohibitsRestraint) {
      excluded.push('detailed restraint/seclusion procedure requirements (extract ONLY the requirement that facilities must have a policy on whether they use or prohibit these interventions)');
    }
    if (!facilityProfile.servicesOffered?.includes('prevention')) {
      excluded.push('prevention services requirements');
    }
    if (!facilityProfile.servicesOffered?.includes('animalTherapy')) {
      excluded.push('animal-assisted therapy requirements');
    }
    if (!facilityProfile.servicesOffered?.includes('cliaWaived')) {
      excluded.push('CLIA-waived testing program requirements');
    }
    if (!facilityProfile.servicesOffered?.includes('ccbhc')) {
      excluded.push('CCBHC certification requirements');
    }

    if (excluded.length > 0) {
      exclusions = `\n\nEXCLUDE these requirement categories (not applicable to this facility):\n${excluded.map(e => `- ${e}`).join('\n')}`;
    }
  }

  // Domain-specific focus or broad extraction
  let domainInstruction = '';
  if (domain === 'all') {
    domainInstruction = `\nExtract ALL operational requirements from this source across all domains. Tag each with the appropriate topic.`;
  } else {
    domainInstruction = `\nFOCUS: Only extract requirements relevant to the "${domain}" policy domain.`;
  }

  return `You are a regulatory compliance expert for behavioral health organizations. Extract requirements from this regulatory/standards source.

SOURCE: ${sourceName}
${domainInstruction}${exclusions}

TEXT:
${sourceText}

INSTRUCTIONS:
- Extract each distinct obligation, standard, or requirement as a separate item.
- For TJC: each Element of Performance (EP) is typically one requirement.
- For state regulations: each subsection with a distinct obligation is one requirement.
- CONSOLIDATE related items: if a regulation lists sub-items that are all part of the same requirement (e.g., "the record shall contain: A) assessments, B) plans, C) notes..."), extract as ONE requirement describing the complete obligation.
- Skip requirements purely administrative to the licensing agency (application forms, fee schedules, renewal procedures).
- Include the topic category for grouping.

Return a JSON object (no other text, no markdown fences):

{
  "requirements": [
    {
      "id": "R1",
      "source_type": "state_reg or tjc or federal or guidelines",
      "citation": "Specific citation (e.g., 65D-30.004(6)(a), PC.01.02.01 EP1, 42 CFR Part 2)",
      "requirement": "Clear statement of the operational obligation",
      "topic": "One of: assessment, treatment_planning, documentation, medical_director, medication_management, infection_control, patient_rights, consent, discharge, case_management, counseling, supervision, emergency_management, incident_reporting, overdose_prevention, telehealth, drug_screening, patient_education, staffing, medical_protocols, quality_improvement, environment_of_care, information_management, other"
    }
  ]
}

Return ONLY the JSON object.`;
};

function parseJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON found in response');
  let jsonStr = text.slice(start);

  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    const lastComplete = jsonStr.lastIndexOf('},');
    if (lastComplete > 0) {
      jsonStr = jsonStr.slice(0, lastComplete + 1) + ']}';
      try { return JSON.parse(jsonStr); } catch {}
    }
    const lastComplete2 = jsonStr.lastIndexOf('}');
    if (lastComplete2 > 0) {
      jsonStr = jsonStr.slice(0, lastComplete2 + 1) + ']}';
      try { return JSON.parse(jsonStr); } catch {}
    }
    throw new Error('Could not parse response JSON');
  }
}

export async function POST(req) {
  try {
    const { domain, sourceName, chunkText, facilityProfile } = await req.json();

    if (!domain || !sourceName || !chunkText) {
      return Response.json({ error: 'Missing domain, sourceName, or chunkText' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      messages: [{ role: 'user', content: EXTRACT_PROMPT(domain, sourceName, chunkText, facilityProfile || null) }],
    });

    const parsed = parseJSON(message.content[0].text);
    return Response.json({ requirements: parsed.requirements || [] });
  } catch (err) {
    console.error('Extract error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
