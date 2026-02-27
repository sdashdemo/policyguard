// lib/audit.js — Immutable audit event logging

import { db } from './db.js';
import { sql } from 'drizzle-orm';
import { ulid } from './ulid.js';

/**
 * Log an audit event to the audit_events table
 */
export async function logAuditEvent(event) {
  try {
    await db.execute(sql`
      INSERT INTO audit_events (id, org_id, event_type, entity_type, entity_id, actor, model_id, prompt_version, input_summary, output_summary, metadata)
      VALUES (${ulid('audit')}, 'ars', ${event.event_type}, ${event.entity_type || null}, ${event.entity_id || null}, ${event.actor || 'system'}, ${event.model_id || null}, ${event.prompt_version || null}, ${event.input_summary || null}, ${event.output_summary || null}, ${JSON.stringify(event.metadata || {})}::jsonb)
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
  REWRITE_POLICY: 'rewrite_v7.0',
};

export const MODEL_ID = process.env.ANTHROPIC_MODEL_ID || 'claude-sonnet-4-20250514';
