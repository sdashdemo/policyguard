// lib/audit.js — Immutable audit event logging

import { db } from './db.js';
import { sql } from 'drizzle-orm';

function ulid() {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `audit_${ts}_${rand}`;
}

/**
 * Log an audit event to the audit_events table
 * @param {object} event
 * @param {string} event.event_type - ingestion, extraction, assessment, review, rewrite, action_created
 * @param {string} event.entity_type - obligation, provision, assessment, policy, action_item
 * @param {string} event.entity_id
 * @param {string} event.actor - 'system', 'llm', 'clo', etc.
 * @param {string} [event.model_id]
 * @param {string} [event.prompt_version]
 * @param {string} [event.input_summary]
 * @param {string} [event.output_summary]
 * @param {object} [event.metadata]
 */
export async function logAuditEvent(event) {
  try {
    await db.execute(sql`
      INSERT INTO audit_events (id, org_id, event_type, entity_type, entity_id, actor, model_id, prompt_version, input_summary, output_summary, metadata)
      VALUES (${ulid()}, 'ars', ${event.event_type}, ${event.entity_type || null}, ${event.entity_id || null}, ${event.actor || 'system'}, ${event.model_id || null}, ${event.prompt_version || null}, ${event.input_summary || null}, ${event.output_summary || null}, ${JSON.stringify(event.metadata || {})}::jsonb)
    `);
  } catch (err) {
    console.error('Audit log error:', err.message);
    // Never throw from audit logging — it should not break the main flow
  }
}

export const PROMPT_VERSIONS = {
  EXTRACT_OBLIGATIONS: 'extract_v6.0',
  INDEX_POLICY: 'index_v6.0',
  ASSESS_COVERAGE: 'assess_v6.0',
  REWRITE_POLICY: 'rewrite_v6.0',
};

export const MODEL_ID = 'claude-sonnet-4-20250514';
