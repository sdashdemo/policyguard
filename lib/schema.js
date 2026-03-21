import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb, integer, boolean, real, uuid, uniqueIndex, index, check } from 'drizzle-orm/pg-core';

export const regSources = pgTable('reg_sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  state: text('state'),
  source_type: text('source_type').notNull(),
  jurisdiction: text('jurisdiction'),
  citation_root: text('citation_root'),
  filename: text('filename'),
  full_text: text('full_text'),
  version: text('version'),
  effective_date: text('effective_date'),
  fetch_url: text('fetch_url'),
  extracted_at: timestamp('extracted_at'),
  created_at: timestamp('created_at').defaultNow(),
});

export const obligations = pgTable('obligations', {
  id: text('id').primaryKey(),
  org_id: text('org_id').default('ars'),
  reg_source_id: text('reg_source_id').notNull().references(() => regSources.id, { onDelete: 'cascade' }),
  parent_id: text('parent_id'),
  citation: text('citation').notNull(),
  requirement: text('requirement').notNull(),
  source_type: text('source_type'),
  topics: jsonb('topics').$type(),
  levels_of_care: jsonb('levels_of_care').$type(),
  responsible_party: text('responsible_party'),
  timeframe: text('timeframe'),
  documentation_required: text('documentation_required'),
  applicability: jsonb('applicability').$type(),
  tjc_crosswalk: text('tjc_crosswalk'),
  risk_tier: text('risk_tier').default('unclassified'),
  loc_applicability: jsonb('loc_applicability').$type(),
  exclude_from_assessment: boolean('exclude_from_assessment').default(false),
  exclude_reason: text('exclude_reason'),
  // embedding stored directly in pgvector — accessed via raw SQL, not Drizzle
  created_at: timestamp('created_at').defaultNow(),
});

export const facilityProfiles = pgTable('facility_profiles', {
  id: text('id').primaryKey(),
  org_id: text('org_id').notNull().default('ars'),
  name: text('name').notNull(),
  state: text('state').notNull(),
  abbreviation: text('abbreviation'),
  levels_of_care: jsonb('levels_of_care').$type(),
  license_types: jsonb('license_types').$type(),
  services_offered: jsonb('services_offered').$type(),
  services_excluded: jsonb('services_excluded').$type(),
  accreditations: jsonb('accreditations').$type(),
  prohibits_restraint: boolean('prohibits_restraint').default(true), // legacy — migrated to attributes JSONB
  smoking_in_buildings_allowed: boolean('smoking_in_buildings_allowed'), // legacy
  allows_patient_work_program: boolean('allows_patient_work_program'), // legacy
  operates_otp: boolean('operates_otp'), // legacy
  attributes: jsonb('attributes').$type(), // dynamic facility attributes — see lib/facility-attributes.js
  bed_count: integer('bed_count'),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at'),
});

export const policies = pgTable('policies', {
  id: text('id').primaryKey(),
  org_id: text('org_id').notNull().default('ars'),
  facility_id: text('facility_id').references(() => facilityProfiles.id),
  policy_number: text('policy_number'),
  title: text('title').notNull(),
  source_file: text('source_file'),
  domain: text('domain'),
  sub_domain: text('sub_domain'),
  sub_domain_label: text('sub_domain_label'),
  facility_name: text('facility_name'),
  effective_date: text('effective_date'),
  revision_dates: text('revision_dates'),
  purpose: text('purpose'),
  summary: text('summary'),
  dcf_citations: jsonb('dcf_citations').$type(),
  tjc_citations: jsonb('tjc_citations').$type(),
  section_headings: jsonb('section_headings').$type(),
  topics_covered: jsonb('topics_covered').$type(),
  header_issues: jsonb('header_issues').$type(),
  full_text: text('full_text'),
  status: text('status').default('active'),
  indexed_at: timestamp('indexed_at'),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at'),
});

export const policyVersions = pgTable('policy_versions', {
  id: text('id').primaryKey(),
  policy_id: text('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  version_number: integer('version_number').notNull().default(1),
  source_file: text('source_file'),
  source_file_hash: text('source_file_hash'),
  effective_date: text('effective_date'),
  full_text: text('full_text'),
  change_summary: text('change_summary'),
  created_by: text('created_by'),
  created_at: timestamp('created_at').defaultNow(),
});

export const provisions = pgTable('provisions', {
  id: text('id').primaryKey(),
  policy_id: text('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  text: text('text').notNull(),
  section: text('section'),
  source_citation: text('source_citation'),
  keywords: jsonb('keywords').$type(),
  // embedding stored directly in pgvector — accessed via raw SQL
  created_at: timestamp('created_at').defaultNow(),
});

export const coverageAssessments = pgTable('coverage_assessments', {
  id: text('id').primaryKey(),
  org_id: text('org_id').notNull().default('ars'),
  facility_id: text('facility_id').references(() => facilityProfiles.id),
  obligation_id: text('obligation_id').notNull().references(() => obligations.id, { onDelete: 'cascade' }),
  policy_id: text('policy_id').references(() => policies.id),
  provision_id: text('provision_id').references(() => provisions.id),
  status: text('status').notNull(),
  confidence: text('confidence'),
  gap_detail: text('gap_detail'),
  recommended_policy: text('recommended_policy'),
  obligation_span: text('obligation_span'),
  provision_span: text('provision_span'),
  reasoning: text('reasoning'),
  trigger_span: text('trigger_span'),
  inapplicability_reason: text('inapplicability_reason'),
  conflict_detail: text('conflict_detail'),
  reviewed_provision_refs: jsonb('reviewed_provision_refs').$type(),
  covering_policy_number: text('covering_policy_number'),
  match_method: text('match_method'),
  match_score: integer('match_score'),
  vector_score: real('vector_score'),
  keyword_score: integer('keyword_score'),
  map_run_id: text('map_run_id'),
  assessed_by: text('assessed_by').default('llm'),
  model_id: text('model_id'),
  prompt_version: text('prompt_version'),
  human_status: text('human_status'),
  reviewed_by: text('reviewed_by'),
  reviewed_at: timestamp('reviewed_at'),
  review_notes: text('review_notes'),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at'),
});

export const assessmentPolicyLinks = pgTable('assessment_policy_links', {
  id: uuid('id').defaultRandom().primaryKey(),
  assessment_id: text('assessment_id').notNull().references(() => coverageAssessments.id, { onDelete: 'cascade' }),
  policy_id: text('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  link_basis: text('link_basis').notNull(),
  linked_by: text('linked_by'),
  note: text('note'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  assessmentIdUnique: uniqueIndex('uq_assessment_policy_links_assessment_id').on(table.assessment_id),
  policyIdIdx: index('idx_assessment_policy_links_policy_id').on(table.policy_id),
  linkBasisCheck: check(
    'assessment_policy_links_link_basis_check',
    sql`${table.link_basis} in ('covering_policy_number_backfill', 'reviewer_selected')`,
  ),
}));

export const policyHealthChecks = pgTable('policy_health_checks', {
  id: uuid('id').defaultRandom().primaryKey(),
  assessment_id: text('assessment_id').notNull().references(() => coverageAssessments.id, { onDelete: 'cascade' }),
  policy_id: text('policy_id').notNull().references(() => policies.id, { onDelete: 'cascade' }),
  summary: text('summary').notNull(),
  findings_json: jsonb('findings_json').$type().notNull(),
  prompt_version: text('prompt_version').notNull(),
  model_id: text('model_id'),
  context_hash: text('context_hash'),
  generated_at: timestamp('generated_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  assessmentIdUnique: uniqueIndex('uq_policy_health_checks_assessment_id').on(table.assessment_id),
  policyIdIdx: index('idx_policy_health_checks_policy_id').on(table.policy_id),
}));

export const assessmentFixSuggestions = pgTable('assessment_fix_suggestions', {
  id: uuid('id').defaultRandom().primaryKey(),
  assessment_id: text('assessment_id').notNull().references(() => coverageAssessments.id, { onDelete: 'cascade' }),
  policy_health_check_id: uuid('policy_health_check_id').references(() => policyHealthChecks.id, { onDelete: 'set null' }),
  summary: text('summary').notNull(),
  suggested_fix: text('suggested_fix').notNull(),
  implementation_notes: text('implementation_notes'),
  raw_response_json: jsonb('raw_response_json').$type().notNull(),
  prompt_version: text('prompt_version').notNull(),
  model_id: text('model_id'),
  generated_at: timestamp('generated_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  assessmentIdUnique: uniqueIndex('uq_assessment_fix_suggestions_assessment_id').on(table.assessment_id),
  policyHealthCheckIdx: index('idx_assessment_fix_suggestions_policy_health_check_id').on(table.policy_health_check_id),
}));

export const assessmentReviews = pgTable('assessment_reviews', {
  id: uuid('id').defaultRandom().primaryKey(),
  assessment_id: text('assessment_id').notNull().references(() => coverageAssessments.id, { onDelete: 'cascade' }),
  disposition: text('disposition').notNull().default('unreviewed'),
  override_status: text('override_status'),
  note: text('note'),
  dismiss_reason: text('dismiss_reason'),
  reviewed_by: text('reviewed_by'),
  reviewed_at: timestamp('reviewed_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => ({
  assessmentIdUnique: uniqueIndex('uq_assessment_reviews_assessment_id').on(table.assessment_id),
  dispositionCheck: check(
    'assessment_reviews_disposition_check',
    sql`${table.disposition} in ('unreviewed', 'confirmed', 'overridden', 'flagged_engine_defect', 'dismissed')`,
  ),
  overrideStatusCheck: check(
    'assessment_reviews_override_status_check',
    sql`${table.override_status} in ('COVERED', 'PARTIAL', 'GAP', 'CONFLICTING', 'NOT_APPLICABLE', 'REVIEW_NEEDED', 'NEEDS_LEGAL_REVIEW')`,
  ),
}));

export const systemDefects = pgTable('system_defects', {
  id: uuid('id').defaultRandom().primaryKey(),
  assessment_id: text('assessment_id').notNull().references(() => coverageAssessments.id, { onDelete: 'cascade' }),
  defect_class: text('defect_class').notNull(),
  status: text('status').notNull().default('open'),
  severity: text('severity').notNull().default('medium'),
  seeded_from: text('seeded_from'),
  note: text('note'),
  owner: text('owner'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  resolved_at: timestamp('resolved_at', { withTimezone: true }),
}, (table) => ({
  assessmentIdUnique: uniqueIndex('uq_system_defects_assessment_id').on(table.assessment_id),
  defectClassCheck: check(
    'system_defects_defect_class_check',
    sql`${table.defect_class} in ('packet', 'neighbor_drift', 'applicability', 'retrieval', 'citation_extraction', 'json_parse', 'admin_boundary', 'other')`,
  ),
  statusCheck: check(
    'system_defects_status_check',
    sql`${table.status} in ('open', 'acknowledged', 'fixed', 'wont_fix')`,
  ),
  severityCheck: check(
    'system_defects_severity_check',
    sql`${table.severity} in ('low', 'medium', 'high')`,
  ),
}));

export const mapRuns = pgTable('map_runs', {
  id: text('id').primaryKey(),
  org_id: text('org_id').notNull().default('ars'),
  facility_id: text('facility_id').references(() => facilityProfiles.id),
  state: text('state').notNull(),
  scope: text('scope'),
  label: text('label'),
  status: text('status').default('running'),
  reg_sources_used: jsonb('reg_sources_used').$type(),
  total_obligations: integer('total_obligations'),
  covered: integer('covered'),
  partial: integer('partial'),
  gaps: integer('gaps'),
  not_applicable: integer('not_applicable'),
  needs_legal_review: integer('needs_legal_review'),
  model_id: text('model_id'),
  prompt_version: text('prompt_version'),
  embedding_model: text('embedding_model'),
  started_at: timestamp('started_at'),
  completed_at: timestamp('completed_at'),
  created_at: timestamp('created_at').defaultNow(),
});

export const actionItems = pgTable('action_items', {
  id: text('id').primaryKey(),
  org_id: text('org_id').notNull().default('ars'),
  assessment_id: text('assessment_id').references(() => coverageAssessments.id),
  obligation_id: text('obligation_id').references(() => obligations.id),
  policy_id: text('policy_id').references(() => policies.id),
  type: text('type').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  owner: text('owner'),
  due_date: text('due_date'),
  priority: text('priority').default('medium'),
  status: text('status').default('open'),
  resolution_notes: text('resolution_notes'),
  completed_at: timestamp('completed_at'),
  created_at: timestamp('created_at').defaultNow(),
  updated_at: timestamp('updated_at'),
});

export const auditEvents = pgTable('audit_events', {
  id: text('id').primaryKey(),
  org_id: text('org_id').notNull().default('ars'),
  event_type: text('event_type').notNull(),
  entity_type: text('entity_type'),
  entity_id: text('entity_id'),
  actor: text('actor'),
  model_id: text('model_id'),
  prompt_version: text('prompt_version'),
  input_summary: text('input_summary'),
  output_summary: text('output_summary'),
  metadata: jsonb('metadata').$type(),
  created_at: timestamp('created_at').defaultNow(),
});

export const appState = pgTable('app_state', {
  key: text('key').primaryKey(),
  org_id: text('org_id').notNull().default('ars'),
  value: jsonb('value'),
  updated_at: timestamp('updated_at').defaultNow(),
});

export const subDomainLabels = pgTable('sub_domain_labels', {
  prefix: text('prefix').primaryKey(),
  domain: text('domain').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  affinity_keywords: jsonb('affinity_keywords').$type(),
});
