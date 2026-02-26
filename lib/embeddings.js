// lib/embeddings.js — Voyage AI embedding client for pgvector hybrid matching

const VOYAGE_MODEL = 'voyage-law-2';
const VOYAGE_URL = 'https://api.voyageai.com/v1/embeddings';
const BATCH_SIZE = 20; // Voyage supports up to 128 per request, but keep small for reliability

/**
 * Generate embeddings for one or more texts using Voyage AI
 * @param {string[]} texts - Array of texts to embed
 * @returns {Promise<number[][]>} Array of embedding vectors (1024-dim)
 */
export async function generateEmbeddings(texts) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not set');

  const allEmbeddings = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const res = await fetch(VOYAGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: batch,
        input_type: 'document',
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Voyage API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const embeddings = data.data.map(d => d.embedding);
    allEmbeddings.push(...embeddings);

    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  return allEmbeddings;
}

/**
 * Generate a single embedding for a query text
 * Uses input_type: 'query' for better retrieval performance
 */
export async function generateQueryEmbedding(text) {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error('VOYAGE_API_KEY not set');

  const res = await fetch(VOYAGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: [text],
      input_type: 'query',
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.data[0].embedding;
}

/**
 * Format embedding array as pgvector string for SQL insertion
 */
export function toPgVector(embedding) {
  return `[${embedding.join(',')}]`;
}
