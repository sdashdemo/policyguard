import { db } from '@/lib/db';
import { regSources, policies } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';
import mammoth from 'mammoth';
import WordExtractor from 'word-extractor';
import Anthropic from '@anthropic-ai/sdk';
import { logAuditEvent } from '@/lib/audit';

export const maxDuration = 120;

function ulid(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${ts}_${rand}`;
}

async function extractTextFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractTextFromDoc(buffer) {
  const extractor = new WordExtractor();
  const doc = await extractor.extract(buffer);
  return doc.getBody();
}

async function extractTextFromPdf(buffer) {
  const pdfParse = (await import('pdf-parse')).default;
  const data = await pdfParse(buffer);
  return data.text;
}

async function classifySource(text, filename) {
  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const sample = text.slice(0, 4000);
    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      messages: [{ role: 'user', content: `Analyze this regulatory/standards document and classify it. Based on the text below, return a JSON object (no other text, no markdown fences):

{
  "name": "Short descriptive name (e.g., '65D-30 — DCF Substance Abuse Services', 'TJC BHC Standards', '42 CFR Part 8 — OTP Requirements')",
  "state": "Two-letter state code if state-specific, or null if federal/national",
  "source_type": "One of: State Regulation, Federal Regulation, Accreditation Standards, Statute, Guidelines",
  "citation_root": "The citation prefix used throughout (e.g., '65D-30', '65E-4', 'TJC', '42 CFR 8', 'Ch. 397')"
}

FILENAME: ${filename}

TEXT SAMPLE:
${sample}` }],
    });
    return JSON.parse(message.content[0].text.replace(/```json|```/g, '').trim());
  } catch (err) {
    return null;
  }
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const type = formData.get('type'); // 'reg_source' or 'policy'

    // Manual overrides (optional — used if user edits the auto-detected fields)
    const manualName = formData.get('source_name');
    const manualState = formData.get('state');
    const manualSourceType = formData.get('source_type');
    const manualCitationRoot = formData.get('citation_root');

    if (!file) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    const filename = file.name;
    const buffer = Buffer.from(await file.arrayBuffer());

    // Extract text
    let fullText;
    if (filename.endsWith('.docx')) {
      fullText = await extractTextFromDocx(buffer);
    } else if (filename.endsWith('.doc')) {
      fullText = await extractTextFromDoc(buffer);
    } else if (filename.endsWith('.pdf')) {
      fullText = await extractTextFromPdf(buffer);
    } else if (filename.endsWith('.txt')) {
      fullText = buffer.toString('utf-8');
    } else {
      return Response.json({ error: `Unsupported file type: ${filename}. Use .doc, .docx, .pdf, or .txt` }, { status: 400 });
    }

    if (!fullText || fullText.trim().length < 50) {
      return Response.json({ error: 'Could not extract meaningful text from file' }, { status: 400 });
    }

    if (type === 'reg_source') {
      // Auto-classify with Claude unless manual fields provided
      let classification = null;
      if (!manualName) {
        classification = await classifySource(fullText, filename);
      }

      const sourceName = manualName || classification?.name || filename;
      const sourceState = manualState || classification?.state || null;
      const sourceType = manualSourceType || classification?.source_type || 'State Regulation';
      const citationRoot = manualCitationRoot || classification?.citation_root || null;

      const id = ulid('rs');
      await db.insert(regSources).values({
        id,
        name: sourceName,
        state: sourceState,
        source_type: sourceType,
        citation_root: citationRoot,
        filename,
        full_text: fullText,
        extracted_at: new Date(),
      });

      await logAuditEvent({
        event_type: 'ingestion',
        entity_type: 'reg_source',
        entity_id: id,
        actor: 'clo',
        input_summary: `Uploaded: ${filename}`,
        output_summary: `${fullText.length} chars | auto-classified: ${sourceName} (${sourceState || 'federal'})`,
      });

      return Response.json({
        ok: true,
        id,
        type: 'reg_source',
        filename,
        text_length: fullText.length,
        classified: {
          name: sourceName,
          state: sourceState,
          source_type: sourceType,
          citation_root: citationRoot,
          auto: !manualName,
        },
        preview: fullText.slice(0, 500),
      });

    } else if (type === 'policy') {
      const id = ulid('pol');
      await db.insert(policies).values({
        id,
        org_id: 'ars',
        title: filename.replace(/\.(docx?|pdf|txt)$/i, ''),
        source_file: filename,
        full_text: fullText,
        status: 'uploaded',
      });

      await logAuditEvent({
        event_type: 'ingestion',
        entity_type: 'policy',
        entity_id: id,
        actor: 'clo',
        input_summary: `Uploaded: ${filename}`,
        output_summary: `${fullText.length} chars extracted`,
      });

      return Response.json({
        ok: true,
        id,
        type: 'policy',
        filename,
        text_length: fullText.length,
      });

    } else {
      return Response.json({ error: 'Invalid type — must be reg_source or policy' }, { status: 400 });
    }

  } catch (err) {
    console.error('Upload error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

// Batch upload endpoint - accepts multiple policies at once
export async function PUT(req) {
  try {
    const formData = await req.formData();
    const files = formData.getAll('files');
    
    if (!files.length) {
      return Response.json({ error: 'No files provided' }, { status: 400 });
    }

    const results = [];
    const errors = [];
    const skipped = [];

    // Get existing filenames to skip duplicates
    const existing = await db.execute(sql`SELECT source_file FROM policies WHERE source_file IS NOT NULL`);
    const existingFiles = new Set((existing.rows || existing || []).map(r => r.source_file));

    for (const file of files) {
      try {
        const filename = file.name;

        if (existingFiles.has(filename)) {
          skipped.push(filename);
          continue;
        }

        const buffer = Buffer.from(await file.arrayBuffer());
        
        let fullText;
        if (filename.endsWith('.docx')) {
          fullText = await extractTextFromDocx(buffer);
        } else if (filename.endsWith('.doc')) {
          fullText = await extractTextFromDoc(buffer);
        } else if (filename.endsWith('.pdf')) {
          fullText = await extractTextFromPdf(buffer);
        } else if (filename.endsWith('.txt')) {
          fullText = buffer.toString('utf-8');
        } else {
          errors.push({ filename, error: 'Unsupported file type' });
          continue;
        }

        if (!fullText || fullText.trim().length < 20) {
          errors.push({ filename, error: 'No text extracted' });
          continue;
        }

        const id = ulid('pol');
        await db.insert(policies).values({
          id,
          org_id: 'ars',
          title: filename.replace(/\.(docx?|pdf|txt)$/i, ''),
          source_file: filename,
          full_text: fullText,
          status: 'uploaded',
        });

        results.push({ id, filename, text_length: fullText.length });

      } catch (err) {
        errors.push({ filename: file.name, error: err.message });
      }
    }

    await logAuditEvent({
      event_type: 'ingestion',
      entity_type: 'policy',
      actor: 'clo',
      input_summary: `Batch upload: ${files.length} files`,
      output_summary: `${results.length} uploaded, ${skipped.length} skipped (dups), ${errors.length} errors`,
    });

    return Response.json({
      ok: true,
      uploaded: results.length,
      skipped: skipped.length,
      errors: errors.length,
      results,
      skipped_files: skipped,
      errors_detail: errors,
    });

  } catch (err) {
    console.error('Batch upload error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
