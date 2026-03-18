# Iteration 1 Complete

This note summarizes the current remediation implementation in the working tree as of March 17, 2026. It is based on the files that currently exist under `lib/`, `app/api/v6/remediation/`, `components/remediation/`, `app/remediation/`, `lib/schema.js`, `lib/prompts.js`, and `db-assessment-reviews-migration.sql`.

## What shipped in Iteration 1

| Feature | Current status | Notes |
| --- | --- | --- |
| Review persistence tables (`assessment_reviews`, `system_defects`) | Working | Schema and migration exist. Both tables are keyed to `coverage_assessments.id` as `text`, which matches the current parent key type. |
| Shared remediation query layer (`lib/remediation.js`) | Working | Centralized server-side filtering, grouping, summary, items, and assessment detail loading are in place. |
| Run summary/groups/items/detail read APIs | Working | The current GET routes all delegate to `lib/remediation.js` and follow the same filter contract as the UI. |
| Review mutation route | Working | Confirm, override, dismiss, and flag-as-defect reviewer actions persist to `assessment_reviews`, and defect-flagging upserts `system_defects`. |
| Remediation work surface page | Working | The route-backed grouped work surface is present at `app/remediation/[runId]/page.js` with URL-backed filters, group selection, items, and drawer detail. |
| Drawer review workflow | Working with minor UX follow-up | The drawer supports Suggest Fix, Confirm, Override, Flag as engine issue, and Dismiss. It now uses a compact action panel instead of four always-open forms, but success feedback is still mostly state-refresh driven. |
| Suggest Fix (stateless) | Partial | The route works for matched-policy and no-policy rows, but prompt/output polish is still needed, especially around summary tone for some unmatched GAP rows. |
| XLSX export | Working | The export route reuses the remediation query layer and currently matches UI filter semantics for default, GAP-only, and `includeDefects=true` cases. |

## What was intentionally deferred to Iteration 2

- An explicit `assessment_policy_links` table and backfill. Iteration 1 still relies on `coverage_assessments.covering_policy_number` plus a deduped `policies.policy_number` lookup.
- Persisted Suggest Fix records. The Iteration 1 Suggest Fix flow is stateless and resets per assessment load.
- A `policy_health_checks` cache. Iteration 1 returns lightweight policy-health commentary inline from the LLM call only.
- Policy-link management routes and UI. Reviewers cannot yet relink an assessment to a different policy from the remediation drawer.
- A separate defect queue and defect lifecycle management. Iteration 1 can flag defects, but it does not provide dedicated defect triage or resolution workflows.
- Per-policy standalone export. Iteration 1 exports the filtered remediation surface as a single workbook only.
- Async export jobs, queued report generation, or background LLM generation. Iteration 1 does everything synchronously.
- A richer Suggest Fix response with insertion points, severity-rated health findings, stale citation detection, or defined-term / abbreviation discipline checks.

## Known UX and prompt polish still open

- The no-policy Suggest Fix `summary` can still use evaluative tone such as "critical compliance gap" even after the no-policy prompt was tightened. The draft provision itself is narrower now, but the summary copy can still drift.
- Review-save success is mostly implicit. The drawer refreshes the current review/defect state, but there is no dedicated success toast or persistent confirmation banner.
- `source`, `domain`, and `riskTier` filters in `components/remediation/RemediationWorkspace.js` are freeform text inputs. They work, but discoverability is lower than it would be with curated filter options.
- The summary route returns up to 10 `topPolicies`, but the workspace currently renders only the first 5 of them in the header card.
- Suggest Fix remains per-drawer-session only. Regeneration works and failed regenerations preserve the last successful result, but suggestions are not persisted across assessment changes or page reloads.
- The drawer is cleaner than the earlier four-card version, but it still combines review actions, Suggest Fix output, and full assessment detail in a single panel. That is workable for Iteration 1, but it is still a dense review surface.

## Files created or modified in Iteration 1

### New tables and migration

- `lib/schema.js`
  - Added `assessmentReviews` for `assessment_reviews`.
  - Added `systemDefects` for `system_defects`.
  - Added unique indexes on `assessment_id` for both tables.
  - Added check constraints for review disposition, override status, defect class, defect status, and severity.
- `db-assessment-reviews-migration.sql`
  - Creates `assessment_reviews`.
  - Creates `system_defects`.
  - Creates the unique indexes on `assessment_id`.
  - Documents why `assessment_id` is `text`, not `uuid`, in the migration context.

### Query layer

- `lib/remediation.js`
  - Shared server-side query layer for the remediation summary, groups, items, and assessment detail surfaces.
  - Centralizes filters, unassigned-bucket handling, defect exclusion, deterministic policy lookup, and review/progress aggregation.

### API routes

| File | Method | Path | Purpose |
| --- | --- | --- | --- |
| `app/api/v6/remediation/runs/[runId]/summary/route.js` | `GET` | `/api/v6/remediation/runs/[runId]/summary` | Returns remediation summary counts, progress totals, and top severity groups for a run using the shared filter contract. |
| `app/api/v6/remediation/runs/[runId]/groups/route.js` | `GET` | `/api/v6/remediation/runs/[runId]/groups` | Returns paginated remediation groups keyed by `covering_policy_number` or `Unassigned`. |
| `app/api/v6/remediation/runs/[runId]/items/route.js` | `GET` | `/api/v6/remediation/runs/[runId]/items` | Returns remediation items for a selected policy group, including the `Unassigned` bucket. |
| `app/api/v6/remediation/assessments/[assessmentId]/route.js` | `GET` | `/api/v6/remediation/assessments/[assessmentId]` | Returns full assessment detail, including obligation, matched policy, provisions, review state, and defect state. |
| `app/api/v6/remediation/assessments/[assessmentId]/review/route.js` | `PUT` | `/api/v6/remediation/assessments/[assessmentId]/review` | Persists reviewer dispositions and, when relevant, upserts a `system_defects` row. |
| `app/api/v6/remediation/assessments/[assessmentId]/suggest-fix/route.js` | `POST` | `/api/v6/remediation/assessments/[assessmentId]/suggest-fix` | Generates a stateless Suggest Fix response using `getAssessmentDetail()` and the repo's existing Anthropic/model/parsing patterns. |
| `app/api/v6/remediation/export/route.js` | `POST` | `/api/v6/remediation/export` | Generates a filter-parity XLSX workbook containing Summary, Policy Groups, Items, and Defects sheets. |

### UI components

- `app/remediation/[runId]/page.js`
  - App Router entry point for the grouped remediation work surface.
- `components/remediation/RemediationWorkspace.js`
  - URL-backed filters, summary cards, groups pane, items pane, export trigger, refresh flow, and drawer selection state.
- `components/remediation/RemediationDetailDrawer.js`
  - Assessment detail drawer, review actions, Suggest Fix action/result rendering, matched policy section, review state, and defect state.

### Other

- `AGENTS.md`
  - Repo guidance was updated during Iteration 1 work, but it does not change runtime remediation behavior.

## Suggest Fix prompt-tweak history

The current repo contains only the final `app/api/v6/remediation/assessments/[assessmentId]/suggest-fix/route.js` state. The tweak sequence below is reconstructed from the Iteration 1 implementation and QA pass, not from multiple committed revisions of that route file.

1. Initial Iteration 1 route
   - The route loaded detail with `getAssessmentDetail()`, built an inline remediation-focused prompt, called Anthropic with `MODEL_ID`, parsed JSON with `parseJSON`, and returned a stateless response.
   - This worked for matched-policy and no-policy rows, but unmatched GAP outputs could drift into broad compliance-policy language.

2. First no-policy tightening
   - Added no-policy-only guidance telling the model to draft the narrowest reviewer-usable provision language tied directly to the cited regulation.
   - Explicitly discouraged generic compliance boilerplate such as annual review language, designated owners, public posting, or workflow steps unless the citation supported them.
   - Result: unmatched GAP `suggestedFix` output became narrower and more citation-anchored.

3. Second no-policy tightening
   - Added another no-policy-only instruction requiring the minimum policy provision language, typically 1 to 3 sentences, unless the citation clearly required more.
   - Explicitly banned invented roles, ownership, compliance-officer language, leadership notifications, monitoring steps, renewal calendars, reporting workflows, and escalation processes unless the regulation clearly supported them.
   - Also asked the model to avoid evaluative phrases like "critical compliance gap" and state the deficiency neutrally.
   - Result: unmatched GAP `suggestedFix` output stopped inventing ownership and workflow language and stayed much tighter to the obligation.

4. What improved
   - No-policy `suggestedFix` text is narrower than the original broad-policy style.
   - Unmatched outputs are better anchored to the cited requirement.
   - The route still works for matched-policy rows without changing their general behavior.

5. What still remains
   - The `summary` field can still come back with evaluative or alarmist language on some no-policy GAP rows.
   - The route still returns a flat `summary` plus `suggestedFix` string rather than a richer persisted structure with insertion points or structured health findings.

## Current limitations and known gaps

- `assessment_reviews.reviewed_by` exists in the schema but is not populated by the current review mutation route.
- Reviewer overrides do not mutate `coverage_assessments`. The correction is stored only in `assessment_reviews.override_status`, which is the intended Iteration 1 behavior.
- `system_defects` rows are created or updated when a reviewer flags an engine issue, but defect rows are intentionally left untouched when the reviewer later chooses another disposition. Dedicated lifecycle cleanup was deferred.
- The grouped remediation surface still depends on `coverage_assessments.covering_policy_number` for grouping and policy matching. There is no reviewer-managed explicit policy link yet.
- Suggest Fix is stateless. There is no `assessment_fix_suggestions` persistence, no cache invalidation, and no ability to compare current vs prior generations.
- Policy-health output is lightweight and one-off. There is no `policy_health_checks` cache, no severity rating, no insertion-point guidance, and no stale-citation detection yet.
- The export route produces a single workbook for the current filtered surface only. There is no per-policy report, no async job, and no long-running export management.
- The optional `/remediation` redirect page was not added. The current page entry point is the run-specific route only.

## Dependencies on Iteration 2

| Iteration 1 limitation | Iteration 2 dependency that resolves it |
| --- | --- |
| Grouping and policy detail still rely on `covering_policy_number` instead of an explicit reviewer-managed link | Add `assessment_policy_links`, backfill it from current data, and update `lib/remediation.js` to prefer the explicit link when present |
| Suggest Fix is stateless and resets per assessment reload | Add `assessment_fix_suggestions` persistence and extend the existing Suggest Fix route/UI to read and refresh persisted results |
| Policy-health output is lightweight and regenerated every time | Add `policy_health_checks` and make Suggest Fix and policy exports read from or refresh that cache |
| No dedicated defect triage, owner management, or resolution workflow | Add a defect queue surface plus lifecycle routes for updating `system_defects.status`, `owner`, `note`, and `resolved_at` |
| No reviewer policy-link correction workflow | Add policy-link management routes and drawer UI so reviewers can search policies, relink assessments, or clear a bad link |
| Export is workbook-wide only | Add a per-policy standalone export route and UI entry point once explicit policy linking is available |
| Suggest Fix summary and health output lack structure | Upgrade the prompt and response shape to separate draft language from implementation notes and emit structured health findings with severity and insertion-point guidance |
