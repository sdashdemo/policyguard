import { db } from '@/lib/db';
import { appState } from '@/lib/schema';
import { eq, and } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const ORG_ID = 'ars';

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');
    const keys = searchParams.get('keys');

    if (key) {
      const rows = await db.select()
        .from(appState)
        .where(and(eq(appState.org_id, ORG_ID), eq(appState.key, key)));
      if (rows.length === 0) return Response.json({ value: null });
      return Response.json({ value: rows[0].value });
    }

    if (keys) {
      const keyList = keys.split(',').map(k => k.trim());
      const result = {};
      for (const k of keyList) {
        const rows = await db.select()
          .from(appState)
          .where(and(eq(appState.org_id, ORG_ID), eq(appState.key, k)));
        result[k] = rows.length > 0 ? rows[0].value : null;
      }
      return Response.json(result);
    }

    const rows = await db.select()
      .from(appState)
      .where(eq(appState.org_id, ORG_ID));
    const result = {};
    for (const row of rows) { result[row.key] = row.value; }
    return Response.json(result);

  } catch (err) {
    console.error('DB GET error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const body = await req.json();

    if (body.batch) {
      for (const item of body.batch) {
        await db.insert(appState)
          .values({ key: item.key, org_id: ORG_ID, value: item.value, updated_at: new Date() })
          .onConflictDoUpdate({
            target: [appState.key],
            set: { value: item.value, updated_at: new Date() },
          });
      }
      return Response.json({ ok: true, count: body.batch.length });
    }

    if (body.key) {
      await db.insert(appState)
        .values({ key: body.key, org_id: ORG_ID, value: body.value, updated_at: new Date() })
        .onConflictDoUpdate({
          target: [appState.key],
          set: { value: body.value, updated_at: new Date() },
        });
      return Response.json({ ok: true });
    }

    return Response.json({ error: 'Missing key or batch' }, { status: 400 });

  } catch (err) {
    console.error('DB POST error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function DELETE(req) {
  try {
    const { searchParams } = new URL(req.url);
    const key = searchParams.get('key');
    if (!key) return Response.json({ error: 'Missing key' }, { status: 400 });
    await db.delete(appState)
      .where(and(eq(appState.org_id, ORG_ID), eq(appState.key, key)));
    return Response.json({ ok: true });
  } catch (err) {
    console.error('DB DELETE error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
}
