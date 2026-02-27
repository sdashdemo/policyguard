// lib/parse.js — Shared JSON parser for LLM responses

/**
 * Extract and parse JSON from an LLM response that may contain markdown fences or preamble.
 * Handles truncated JSON by attempting to close incomplete arrays/objects.
 */
export function parseJSON(text) {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('No JSON found in response');
  let jsonStr = text.slice(start);

  // Try parsing as-is first
  try {
    return JSON.parse(jsonStr);
  } catch (e) {
    // Try closing at last complete object in array
    const lastComplete = jsonStr.lastIndexOf('},');
    if (lastComplete > 0) {
      const attempt = jsonStr.slice(0, lastComplete + 1) + ']}';
      try { return JSON.parse(attempt); } catch {}
    }
    // Try closing at last complete object
    const lastObj = jsonStr.lastIndexOf('}');
    if (lastObj > 0) {
      const attempt = jsonStr.slice(0, lastObj + 1) + ']}';
      try { return JSON.parse(attempt); } catch {}
    }
    throw new Error('Could not parse response JSON: ' + e.message);
  }
}
