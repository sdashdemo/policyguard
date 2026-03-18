# Iteration 2 Plan

This plan is grounded in the current remediation implementation:

- Shared read-side remediation logic lives in `lib/remediation.js`.
- Current remediation APIs live under `app/api/v6/remediation/`.
- The work surface lives in `app/remediation/[runId]/page.js`, `components/remediation/RemediationWorkspace.js`, and `components/remediation/RemediationDetailDrawer.js`.
- Review state is already persisted in `assessment_reviews`.
- Engine-defect state is already persisted in `system_defects`.

The goal of Iteration 2 is to make remediation more durable and reviewer-driven without breaking the filter parity and route-backed semantics established in Iteration 1.

## Recommended build order

1. `assessment_policy_links` table and backfill
   - Dependency reason: this is the foundation for explicit reviewer-managed policy linking.
   - It should land before any policy-link management UI or any export/report that claims canonical policy linkage.

2. Update `lib/remediation.js` to prefer explicit policy links, with fallback to `coverage_assessments.covering_policy_number`
   - Dependency reason: once the table exists, the shared query layer must consume it so summary/groups/items/detail all stay consistent.

3. Policy-link management routes and drawer UI
   - Dependency reason: reviewers need a way to repair bad or missing links after the table exists and the shared query layer can read from it.

4. `policy_health_checks` cache table
   - Dependency reason: richer policy-health analysis should stop being purely transient before the Suggest Fix route is upgraded further.
   - It should be keyed in a way that survives page reloads and can be reused by export.

5. `assessment_fix_suggestions` persistence table
   - Dependency reason: the Suggest Fix route and drawer should persist the latest generated output after the richer policy-health layer exists or is at least designed.

6. Upgrade the existing Suggest Fix route and drawer response shape
   - Dependency reason: once persistence tables exist, the route can return and save a stable richer structure instead of a transient flat string payload.

7. Defect queue lifecycle management
   - Dependency reason: this can run after the core reviewer-state flows are stable. It uses existing `system_defects` data but adds dedicated triage behavior.

8. Per-policy standalone export
   - Dependency reason: this should come after explicit links and richer policy-health data so the report can be policy-centric without drifting from the canonical linkage model.

## Migration and backfill concerns

### 1. Proposed `assessment_policy_links`

- Existing data source:
  - Backfill from `coverage_assessments.covering_policy_number` using the same dedupe rule currently embedded in `lib/remediation.js` for `policy_lookup`.
- What must happen immediately:
  - Create the table.
  - Backfill rows for assessments whose `covering_policy_number` resolves deterministically to a `policies.id`.
  - Leave unmatched or blank `covering_policy_number` rows without a link row.
- What can be backfilled later:
  - Reviewer-managed clean-up for ambiguous or poor legacy links.
- Nullable vs required:
  - `assessment_id`: required.
  - `policy_id`: required if a link row exists.
  - `link_basis`: required.
  - `linked_by`, `note`: nullable initially.

### 2. Proposed `policy_health_checks`

- Existing data source:
  - No reliable backfill exists today because Iteration 1 policy-health output is generated on demand and not persisted.
- What must happen immediately:
  - Create the table empty.
  - Populate lazily from the upgraded Suggest Fix flow or an explicit refresh action.
- What can be backfilled later:
  - If needed, backfill only high-priority or high-score policy groups after the table is live.
- Nullable vs required:
  - `assessment_id`: required if the cache remains assessment-scoped.
  - `policy_id`: required for matched-policy rows.
  - `summary`, `findings_json`, `prompt_version`, `generated_at`: required.
  - `context_hash`: nullable initially if cache invalidation is handled conservatively at first.

### 3. Proposed `assessment_fix_suggestions`

- Existing data source:
  - No persisted source exists today.
- What must happen immediately:
  - Create the table empty.
  - Start populating on Suggest Fix generation.
- What can be backfilled later:
  - No mandatory backfill. If desired, regenerate suggestions only for currently active high-priority items.
- Nullable vs required:
  - `assessment_id`: required.
  - `summary`, `suggested_fix`, `raw_response_json`, `prompt_version`, `generated_at`: required.
  - `policy_health_check_id`: nullable because true GAP / no-policy rows can still have a suggestion without a health-check record.

## Proposed schema changes

These are proposed Iteration 2 additions. They do not exist in the repo yet.

### New tables

#### `assessment_policy_links`

- `id uuid primary key default gen_random_uuid()`
- `assessment_id text not null references coverage_assessments(id)`
- `policy_id text not null references policies(id)`
- `link_basis text not null`
  - Suggested initial values: `covering_policy_number_backfill`, `reviewer_selected`
- `linked_by text null`
- `note text null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes and constraints:

- Unique index on `assessment_id`
- Index on `policy_id`
- Check constraint on `link_basis`

#### `policy_health_checks`

- `id uuid primary key default gen_random_uuid()`
- `assessment_id text not null references coverage_assessments(id)`
- `policy_id text not null references policies(id)`
- `summary text not null`
- `findings_json jsonb not null`
- `prompt_version text not null`
- `model_id text null`
- `context_hash text null`
- `generated_at timestamptz not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes and constraints:

- Unique index on `assessment_id`
- Index on `policy_id`
- Optional index on `generated_at` if staleness cleanup becomes necessary

#### `assessment_fix_suggestions`

- `id uuid primary key default gen_random_uuid()`
- `assessment_id text not null references coverage_assessments(id)`
- `policy_health_check_id uuid null references policy_health_checks(id)`
- `summary text not null`
- `suggested_fix text not null`
- `implementation_notes text null`
- `raw_response_json jsonb not null`
- `prompt_version text not null`
- `model_id text null`
- `generated_at timestamptz not null`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Indexes and constraints:

- Unique index on `assessment_id`
- Index on `policy_health_check_id`

### Existing-table changes

- `system_defects`
  - No new column is strictly required for a first Iteration 2 lifecycle pass because `status`, `severity`, `owner`, `note`, and `resolved_at` already exist.
  - If the team wants clearer auditability, a future `resolution_note` column would help, but it is optional for the first pass.

- `assessment_reviews`
  - No schema change is required immediately.
  - The existing `reviewed_by` column can start being populated once auth or reviewer identity is available.

## API routes needed

These are proposed Iteration 2 additions or extensions. They do not exist yet unless noted.

### Policy-link management

- `GET /api/v6/remediation/assessments/[assessmentId]/policy-link`
  - Returns the current explicit link, current legacy `covering_policy_number`, and enough context to render link-management UI safely.
- `PUT /api/v6/remediation/assessments/[assessmentId]/policy-link`
  - Upserts or replaces the explicit `assessment_policy_links` row for an assessment.
- `DELETE /api/v6/remediation/assessments/[assessmentId]/policy-link`
  - Clears the explicit link so the assessment falls back to legacy matching or `Unassigned`.
- `GET /api/v6/remediation/policies/search`
  - Searches `policies` for reviewer relinking workflows.

### Suggest Fix persistence and richer output

- Extend existing `POST /api/v6/remediation/assessments/[assessmentId]/suggest-fix`
  - Generate the richer structured response.
  - Upsert `policy_health_checks` for matched-policy rows.
  - Upsert `assessment_fix_suggestions` for every successful generation.
- `GET /api/v6/remediation/assessments/[assessmentId]/suggest-fix`
  - Returns the latest persisted suggestion and linked health-check output without regenerating it.

### Defect queue lifecycle

- `GET /api/v6/remediation/defects`
  - Returns defect queue rows with filters such as status, severity, owner, run, source, and policy linkage.
- `GET /api/v6/remediation/defects/[defectId]`
  - Returns one defect record with linked assessment context.
- `PUT /api/v6/remediation/defects/[defectId]`
  - Updates `status`, `severity`, `owner`, `note`, and `resolved_at`.

### Per-policy standalone export

- `POST /api/v6/remediation/policies/[policyId]/export`
  - Builds a policy-centric XLSX workbook for the chosen policy using the same remediation filters where they still apply.

## UI changes needed

### Extend existing surfaces

- `components/remediation/RemediationWorkspace.js`
  - Keep as the main grouped work surface.
  - Add policy-link aware badges or indicators once explicit links exist.
  - Add per-policy export entry points once the standalone export route exists.

- `components/remediation/RemediationDetailDrawer.js`
  - Extend with a policy-link management section.
  - Extend the Suggest Fix area to show persisted suggestion state and richer structured health findings.
  - Extend defect state with lifecycle controls once the defect queue/update routes exist.

### Proposed new components

- `components/remediation/PolicyLinkManager.js`
  - Search, choose, clear, and display explicit assessment-to-policy links.
- `components/remediation/PolicySearchCombobox.js`
  - Searchable policy picker for relinking.
- `components/remediation/PolicyHealthPanel.js`
  - Displays severity-rated health findings, insertion points, stale citation warnings, and term-discipline findings.
- `components/remediation/DefectQueueTable.js`
  - Standalone defect queue view.

### Proposed new pages

- `app/remediation/[runId]/defects/page.js`
  - Dedicated run-scoped defect queue surface.
- Optional `app/remediation/page.js`
  - Redirect to a default run if the team still wants a stable landing route.

## Which Iteration 1 code should be modified vs extended

### Modify

- `lib/remediation.js`
  - Modify to prefer explicit `assessment_policy_links` when present.
  - Keep the current filter contract and grouping logic instead of branching to a second query stack.

- `app/api/v6/remediation/assessments/[assessmentId]/suggest-fix/route.js`
  - Modify rather than replace.
  - Keep the current path, model/provider pattern, and `getAssessmentDetail()` reuse, but expand the response shape and persist outputs.

- `app/api/v6/remediation/export/route.js`
  - Modify only if the general export should start surfacing richer persisted suggestion or health-check columns.
  - Do not fork filter logic away from `lib/remediation.js`.

### Extend

- `components/remediation/RemediationWorkspace.js`
  - Extend for explicit-link state, richer policy indicators, and per-policy export triggers.
- `components/remediation/RemediationDetailDrawer.js`
  - Extend for persisted Suggest Fix display, policy-link management, and defect lifecycle controls.
- `app/remediation/[runId]/page.js`
  - Keep as the main entry point and extend through child components instead of replacing it.

### Add new files instead of bloating existing ones

- New schema definitions in `lib/schema.js`
- New route files under `app/api/v6/remediation/`
- New focused components under `components/remediation/`
- Optional helper modules for persisted suggestion or link management logic if `lib/remediation.js` becomes too crowded

## Upgraded Suggest Fix target shape

The current Iteration 1 route returns:

- `summary`
- `suggestedFix`
- `policyHealth`
- `metadata`

The Iteration 2 target should separate drafting from diagnostic output more clearly.

Recommended shape:

```json
{
  "ok": true,
  "assessmentId": "ca_...",
  "summary": "Neutral reviewer-facing explanation.",
  "suggestedFix": {
    "draftLanguage": "Specific draft provision language.",
    "implementationNotes": [
      "Optional reviewer note",
      "Optional reviewer note"
    ]
  },
  "policyHealth": {
    "summary": "Policy health overview.",
    "findings": [
      {
        "severity": "high",
        "type": "missing_requirement",
        "issue": "What is wrong",
        "suggestedInsertionPoint": "Where to insert or revise language",
        "staleCitation": false,
        "abbreviationDiscipline": false,
        "definedTermDiscipline": true
      }
    ]
  },
  "metadata": {
    "hasMatchedPolicy": true,
    "policyNumber": "LS-1001"
  }
}
```

Why this shape:

- `draftLanguage` vs `implementationNotes` cleanly separates language the reviewer might copy into policy from explanatory reviewer guidance.
- `findings[]` makes severity, insertion points, stale citation detection, and discipline checks explicit instead of burying them in a freeform paragraph.
- The route can still keep `policyHealth: null` for no-policy rows.

## Risks and failure modes

- Data drift between `assessment_policy_links` and `coverage_assessments.covering_policy_number`
  - If the query layer does not clearly prefer one source, summary/groups/items/detail can diverge.

- Backfill ambiguity from duplicate `policies.policy_number`
  - Iteration 1 already works around this with a deterministic dedupe CTE.
  - Iteration 2 backfill must use the same ordering rule or explicitly log ambiguous rows.

- Cache staleness for `policy_health_checks` and `assessment_fix_suggestions`
  - Suggestions can become stale if the policy link changes, provisions are reindexed, or the underlying assessment is re-reviewed.
  - This is where `prompt_version`, `generated_at`, and optionally `context_hash` matter.

- Export parity drift
  - Per-policy export and richer workbook outputs should continue to reuse `lib/remediation.js` or compatible shared helpers.
  - Reimplementing filters in separate export code risks mismatched counts.

- Defect lifecycle inconsistency
  - The Iteration 1 review route can still flag defects while a future defect queue edits defect status independently.
  - The team will need a clear rule for how `assessment_reviews.disposition = flagged_engine_defect` and `system_defects.status` interact after a defect is acknowledged or fixed.

- Migration order
  - If the UI ships before the explicit link table and backfill are stable, reviewers could see inconsistent policy metadata.
  - If persisted Suggest Fix ships before the health-check model is settled, the team may need a second migration or a destructive re-generation pass.

## Estimated relative effort

| Step | Effort |
| --- | --- |
| `assessment_policy_links` schema + backfill | Medium |
| Update `lib/remediation.js` to use explicit links | Medium |
| Policy-link management routes | Medium |
| Policy-link management drawer UI | Medium |
| `policy_health_checks` schema + lazy population | Medium |
| `assessment_fix_suggestions` schema + route persistence | Medium |
| Richer Suggest Fix prompt/response + UI rendering | Large |
| Defect queue lifecycle routes + UI | Large |
| Per-policy standalone export | Medium |

## What can be parallelized vs what must be sequential

### Must be sequential

1. Create and backfill `assessment_policy_links`
2. Update `lib/remediation.js` to read the explicit links
3. Build policy-link management UI on top of that canonical model

### Can be parallelized after link groundwork is stable

- `policy_health_checks` schema and persistence work
- `assessment_fix_suggestions` schema and persistence work
- Richer Suggest Fix drawer rendering
- Defect queue lifecycle routes and UI

### Best left until the richer data model is stable

- Per-policy standalone export
  - It should come after explicit links and persisted health/suggestion data are settled so the export is not redesigned twice.
