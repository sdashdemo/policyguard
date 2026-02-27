import { db } from '@/lib/db';
import { regSources, policies } from '@/lib/schema';
import { eq } from 'drizzle-orm';
import mammoth from 'mammoth';
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

async function extractTextFromPdf(buffer) {
  // Basic text extraction - pdfjsLib in node
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str).join(' ');
      pages.push(text);
    }
    return pages.join('\n\n');
  } catch (err) {
    // Fallback: return error message
    throw new Error(`PDF extraction failed: ${err.message}`);
  }
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const type = formData.get('type'); // 'reg_source' or 'policy'
    
    // Reg source metadata
    const sourceName = formData.get('source_name') || file.name;
    const sourceState = formData.get('state') || null;
    const sourceType = formData.get('source_type') || 'state_reg'; // state_reg, tjc, federal
    const citationRoot = formData.get('citation_root') || null;

    if (!file) {
      return Response.json({ error: 'No file provided' }, { status: 400 });
    }

    const filename = file.name;
    const buffer = Buffer.from(await file.arrayBuffer());
    
    // Extract text based on file type
    let fullText;
    if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
      fullText = await extractTextFromDocx(buffer);
    } else if (filename.endsWith('.pdf')) {
      fullText = await extractTextFromPdf(buffer);
    } else if (filename.endsWith('.txt')) {
      fullText = buffer.toString('utf-8');
    } else {
      return Response.json({ error: `Unsupported file type: ${filename}` }, { status: 400 });
    }

    if (!fullText || fullText.trim().length < 50) {
      return Response.json({ error: 'Could not extract meaningful text from file' }, { status: 400 });
    }

    if (type === 'reg_source') {
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
        output_summary: `${fullText.length} chars extracted`,
      });

      return Response.json({
        ok: true,
        id,
        type: 'reg_source',
        filename,
        text_length: fullText.length,
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

    for (const file of files) {
      try {
        const filename = file.name;
        const buffer = Buffer.from(await file.arrayBuffer());
        
        let fullText;
        if (filename.endsWith('.docx') || filename.endsWith('.doc')) {
          fullText = await extractTextFromDocx(buffer);
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
      output_summary: `${results.length} uploaded, ${errors.length} errors`,
    });

    return Response.json({
      ok: true,
      uploaded: results.length,
      errors: errors.length,
      results,
      errors_detail: errors,
    });

  } catch (err) {
    console.error('Batch upload error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
