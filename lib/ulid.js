// lib/ulid.js — Lightweight unique ID generator

/**
 * Generate a unique ID with optional prefix.
 * Format: prefix_timestamp_random (e.g., "ca_m1abc_x7f2k")
 */
export function ulid(prefix = '') {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${ts}_${rand}` : `${ts}_${rand}`;
}
