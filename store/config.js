'use strict';

const path = require('path');

/**
 * Loads .env (if present) via dotenv and exports a configuration object
 * for the evidence store and retention settings.
 *
 * Override any setting by setting the corresponding environment variable
 * before starting the process, or by creating a .env file (see .env.example).
 */
try {
  require('dotenv').config();
} catch (_) {}

function parsePositiveInteger(name, value, fallback) {
  const parsed = Number.parseInt(value || fallback, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${value || fallback}`);
  }
  return parsed;
}

module.exports = {
  /** 'memory' (default), 'file', or 'sqlite' */
  type: process.env.EVIDENCE_STORE_TYPE || 'memory',

  /** Base directory for file-based persistence (only used when type='file') */
  dir: process.env.EVIDENCE_STORE_DIR || '.evidence-store',

  /** SQLite database path (only used when type='sqlite') */
  dbPath:
    process.env.EVIDENCE_STORE_DB_PATH
    || path.join(process.env.EVIDENCE_STORE_DIR || '.evidence-store', 'evidence-store.sqlite'),

  /** Evidence metadata retention in days (default: 5 years) */
  retentionDays: parsePositiveInteger('EVIDENCE_RETENTION_DAYS', process.env.EVIDENCE_RETENTION_DAYS, '1825'),

  /** Raw snapshot retention in days (default: 1 year) */
  snapshotRetentionDays: parsePositiveInteger('SNAPSHOT_RETENTION_DAYS', process.env.SNAPSHOT_RETENTION_DAYS, '365'),

  /** Fetch log retention in days (default: 6 months) */
  logRetentionDays: parsePositiveInteger('LOG_RETENTION_DAYS', process.env.LOG_RETENTION_DAYS, '180'),
};
