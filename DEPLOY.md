# PolicyGuard v7 — Phase 1 Cleanup Deployment Guide

## Summary of Changes

| Category | v6 | v7 | Change |
|----------|-----|-----|--------|
| page.js | 1,416 lines (monolith) | 92 lines (thin router) | Split into 10 components |
| API routes | 21 | 14 | Deleted 7 dead + db/migrate, added policies + rewrite |
| lib files | 7 | 8 | Removed db-client.js, added parse.js + ulid.js |
| force-dynamic | 1 route | all GET routes | Prevents Vercel caching stale data |
| Model ID | hardcoded | env var fallback | `ANTHROPIC_MODEL_ID` env var |

## Step-by-Step Deployment

### 1. Add new files

Create these new files/folders in your local repo:

**New lib files:**
- `lib/parse.js` — shared JSON parser
- `lib/ulid.js` — shared ID generator

**New components folder:**
- `components/shared.js`
- `components/DashboardMode.js`
- `components/FacilityViewMode.js`
- `components/GapReportMode.js`
- `components/FacilityMatrixMode.js`
- `components/RegulationsMode.js`
- `components/PoliciesMode.js` ← fixed (uses new /api/v6/policies)
- `components/PolicyRewriteMode.js` ← fixed (uses new /api/v6/rewrite)
- `components/ActionsMode.js`
- `components/PipelineMode.js`

**New API routes:**
- `app/api/v6/policies/route.js` — proper policy listing endpoint
- `app/api/v6/rewrite/route.js` — loads from DB, streams response

### 2. Replace existing files

These files are updated in place:

- `app/page.js` — thin router (was monolith)
- `lib/audit.js` — env var model ID, shared ulid import
- `app/api/v6/pipeline/route.js` — already had force-dynamic (no change)
- `app/api/v6/dashboard/route.js` — added force-dynamic
- `app/api/v6/gaps/route.js` — added force-dynamic
- `app/api/v6/facilities/route.js` — added force-dynamic
- `app/api/v6/extract/route.js` — force-dynamic + shared utils
- `app/api/v6/actions/route.js` — force-dynamic + shared ulid
- `app/api/v6/index/route.js` — force-dynamic + shared utils
- `app/api/v6/assess/route.js` — force-dynamic + shared utils
- `app/api/v6/upload/route.js` — shared ulid
- `app/api/db/route.js` — force-dynamic

### 3. Delete dead files

Remove these entirely:

**Dead API routes (7):**
- `app/api/assess-coverage/` (entire folder)
- `app/api/coverage-results/` (entire folder)
- `app/api/extract-requirements/` (entire folder)
- `app/api/index-policy/` (entire folder)
- `app/api/map-coverage/` (entire folder)
- `app/api/map-domain/` (entire folder)
- `app/api/match-candidates/` (entire folder)

**Dead migration route:**
- `app/api/db/migrate/` (entire folder)

**Dead lib file:**
- `lib/db-client.js`

**Dead legacy route:**
- `app/api/rewrite-policy/` (entire folder) — replaced by `app/api/v6/rewrite/`

### 4. Optional: Add env var in Vercel

In Vercel dashboard → Settings → Environment Variables:
- `ANTHROPIC_MODEL_ID` = `claude-sonnet-4-20250514` (or whatever current model)
- Not required — falls back to hardcoded value if not set

### 5. Run DB indexes

In Supabase SQL Editor, run `db-indexes.sql` (included in this package).

### 6. Deploy

Standard workflow: commit → push → Vercel auto-deploys.

### 7. Verify

After deploy, check:
- [ ] Dashboard loads with real numbers
- [ ] Pipeline shows all 6 steps complete
- [ ] Gap Report shows 371 gaps
- [ ] Policies mode shows policy list (not derived from gaps)
- [ ] Policy Rewrite → select a policy → Generate AI Rewrite works
- [ ] Facility Matrix loads
- [ ] Sidebar shows "v7"

## What's NOT Changed

These files are identical to v6:
- `lib/db.js`
- `lib/schema.js`
- `lib/embeddings.js`
- `lib/matching.js`
- `lib/prompts.js`
- `app/globals.css`
- `app/layout.js`
- `package.json`
- `next.config.js`
- `tailwind.config.js`
- `jsconfig.json`
- `postcss.config.js`
- `app/api/v6/embed/route.js`
- `app/api/v6/review/route.js`
