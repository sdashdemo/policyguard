let pendingSaves = {};
let saveTimer = null;
const DEBOUNCE_MS = 1000;

export function saveToDb(key, value) {
  pendingSaves[key] = value;
  try { localStorage.setItem(`pg_${key}`, JSON.stringify(value)); } catch {}
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, DEBOUNCE_MS);
}

async function flushSaves() {
  const batch = Object.entries(pendingSaves).map(([key, value]) => ({ key, value }));
  pendingSaves = {};
  if (batch.length === 0) return;
  try {
    await fetch('/api/db', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch }),
    });
  } catch (err) {
    console.warn('DB save failed, localStorage fallback active:', err.message);
  }
}

export async function loadAllFromDb() {
  const keys = 'index,maps,rewrites,profile,customDomains,regSources,overrides,mapState';
  try {
    const res = await fetch(`/api/db?keys=${keys}`);
    if (!res.ok) throw new Error(`DB load failed: ${res.status}`);
    const data = await res.json();
    const hasData = Object.values(data).some(v => v !== null);
    if (hasData) return { source: 'db', data };
  } catch (err) {
    console.warn('DB load failed, falling back to localStorage:', err.message);
  }
  const fallback = {};
  for (const key of keys.split(',')) {
    try {
      const v = localStorage.getItem(`pg_${key}`);
      fallback[key] = v ? JSON.parse(v) : null;
    } catch { fallback[key] = null; }
  }
  return { source: 'localStorage', data: fallback };
}

export async function migrateToDb() {
  const keys = ['index', 'maps', 'rewrites', 'profile', 'customDomains', 'overrides', 'mapState'];
  let saved = 0;
  let failed = [];

  // Step 1: Save each key to app_state (raw key-value)
  for (const key of keys) {
    try {
      const v = localStorage.getItem(`pg_${key}`);
      if (!v) continue;
      const parsed = JSON.parse(v);
      const payload = JSON.stringify({ key, value: parsed });
      if (payload.length < 3000000) {
        const res = await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
        if (res.ok) saved++; else failed.push(key);
      } else {
        let slimmed = parsed;
        if (key === 'maps' && typeof parsed === 'object') {
          slimmed = {};
          for (const [k, v] of Object.entries(parsed)) {
            slimmed[k] = { ...v, requirements: v.requirements?.length + ' items (trimmed)' };
          }
        }
        const res = await fetch('/api/db', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: slimmed }) });
        if (res.ok) saved++; else failed.push(key);
      }
   } catch (err) { failed.push(key + ': ' + err.message); }
  }

  // Step 2: Normalize into structured tables via /api/db/migrate
  let migrateMsg = '';
  try {
    const migratePayload = {};
    try { const v = localStorage.getItem('pg_index'); if (v) migratePayload.index = JSON.parse(v); } catch {}
    try { const v = localStorage.getItem('pg_profile'); if (v) migratePayload.profile = JSON.parse(v); } catch {}

    if (migratePayload.index && Array.isArray(migratePayload.index)) {
      migratePayload.index = migratePayload.index.map(p => ({ ...p, full_text: null }));
    }

    const res1 = await fetch('/api/db/migrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(migratePayload),
    });
    if (res1.ok) {
      const r1 = await res1.json();
      migrateMsg = r1.message || '';
    }

    try {
      const v = localStorage.getItem('pg_regSources');
      if (v) {
        const sources = JSON.parse(v);
        let regCount = 0, oblCount = 0;
 for (const src of sources) {
          const reqs = src.extractedReqs || [];
          const CHUNK = 200;
          for (let i = 0; i < reqs.length || i === 0; i += CHUNK) {
            const chunk = reqs.slice(i, i + CHUNK);
            const slimSrc = { ...src, text: null, extractedReqs: chunk };
            try {
              const res = await fetch('/api/db/migrate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ regSources: [slimSrc] }),
              });
              if (res.ok) {
                const r = await res.json();
                if (i === 0) regCount += r.results?.regSources || 0;
                oblCount += r.results?.obligations || 0;
              }
            } catch (err) { console.warn(`Chunk ${i} for ${src.name}:`, err.message); }
          }
        }
        migrateMsg += ` + ${regCount} reg sources, ${oblCount} obligations`;
      }
    } catch (err) { console.warn('RegSource migration:', err.message); }

  } catch (err) {
    console.error('Migration error:', err);
    migrateMsg = 'Normalization failed: ' + err.message;
  }

  return {
    ok: true,
    message: `Saved ${saved} keys. ${migrateMsg}${failed.length ? ' Failed: ' + failed.join(', ') : ''}`,
  };
}
