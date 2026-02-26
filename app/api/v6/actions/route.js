import { db } from '@/lib/db';
import { actionItems } from '@/lib/schema';
import { eq, sql } from 'drizzle-orm';

function ulid() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `action_${ts}_${rand}`;
}

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status');

    let results;
    if (status && status !== 'all') {
      results = await db.select().from(actionItems).where(eq(actionItems.status, status));
    } else {
      results = await db.select().from(actionItems);
    }

    return Response.json({ actions: results });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { type, title, description, owner, due_date, priority, assessment_id, obligation_id, policy_id } = body;

    if (!type || !title) {
      return Response.json({ error: 'Missing type or title' }, { status: 400 });
    }

    const id = ulid();
    await db.insert(actionItems).values({
      id,
      org_id: 'ars',
      type,
      title,
      description: description || null,
      owner: owner || null,
      due_date: due_date || null,
      priority: priority || 'medium',
      assessment_id: assessment_id || null,
      obligation_id: obligation_id || null,
      policy_id: policy_id || null,
    });

    return Response.json({ ok: true, id });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function PUT(req) {
  try {
    const body = await req.json();
    const { id, status, resolution_notes, owner, due_date, priority } = body;

    if (!id) return Response.json({ error: 'Missing id' }, { status: 400 });

    const updates = { updated_at: new Date() };
    if (status) updates.status = status;
    if (resolution_notes !== undefined) updates.resolution_notes = resolution_notes;
    if (owner !== undefined) updates.owner = owner;
    if (due_date !== undefined) updates.due_date = due_date;
    if (priority !== undefined) updates.priority = priority;
    if (status === 'completed') updates.completed_at = new Date();

    await db.update(actionItems).set(updates).where(eq(actionItems.id, id));

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
