import Anthropic from '@anthropic-ai/sdk';
import { INDEX_PROMPT } from '@/lib/prompts';

export const maxDuration = 60;

export async function POST(req) {
  try {
    const { filename, text, customDomains } = await req.json();

    if (!text || !filename) {
      return Response.json({ error: 'Missing filename or text' }, { status: 400 });
    }

    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8096,
      messages: [{ role: 'user', content: INDEX_PROMPT(filename, text, customDomains || []) }],
    });

    const responseText = message.content[0].text;

    // Parse JSON from response
    const jsonStart = responseText.indexOf('{');
    const jsonEnd = responseText.lastIndexOf('}') + 1;
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(responseText.slice(jsonStart, jsonEnd));
      parsed.source_file = filename;
      parsed.indexed_at = new Date().toISOString();
      return Response.json(parsed);
    }

    return Response.json({ error: 'Could not parse response', raw: responseText }, { status: 500 });
  } catch (err) {
    console.error('Index error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
