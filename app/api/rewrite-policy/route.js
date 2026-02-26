import Anthropic from '@anthropic-ai/sdk';
import { REWRITE_PROMPT } from '@/lib/prompts';

export const maxDuration = 120;

export async function POST(req) {
  try {
    const { policy, domainMap, regulations, allPolicies } = await req.json();

    if (!policy || !domainMap || !regulations) {
      return Response.json({ error: 'Missing policy, domainMap, or regulations' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Build context from domain map
    const coverage = domainMap.coverage || [];
    const policyId = policy.policy_id?.toUpperCase();

    const assigned = coverage.filter(c =>
      c.recommended_policy?.toUpperCase() === policyId ||
      c.covering_policy?.toUpperCase() === policyId ||
      (c.status === 'GAP' && !c.recommended_policy)
    );

    const siblings = coverage.filter(c =>
      c.covering_policy?.toUpperCase() !== policyId &&
      c.recommended_policy?.toUpperCase() !== policyId
    );

    const regText = Object.entries(regulations)
      .map(([name, text]) => `SOURCE: ${name}\n\n${text}`)
      .join('\n\n---\n\n');

    const prompt = REWRITE_PROMPT(
      policy.policy_id,
      policy.title,
      policy.full_text,
      domainMap.domain,
      regText.slice(0, 60000),
      JSON.stringify(assigned, null, 2),
      JSON.stringify(siblings.map(s => ({
        req: s.description,
        covered_by: s.covering_policy,
        status: s.status
      })), null, 2)
    );

    // Stream the response
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      messages: [{ role: 'user', content: prompt }],
    });

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of stream) {
            if (event.type === 'content_block_delta' && event.delta?.text) {
              controller.enqueue(encoder.encode(event.delta.text));
            }
          }
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    });

    return new Response(readable, {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  } catch (err) {
    console.error('Rewrite error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
