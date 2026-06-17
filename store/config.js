'use strict';

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

module.exports = {
  /** 'memory' (default) or 'file' */
  type: process.env.EVIDENCE_STORE_TYPE || 'memory',

  /** Base directory for file-based persistence (only used when type='file') */
  dir: process.env.EVIDENCE_STORE_DIR || '.evidence-store',

  /** Evidence metadata retention in days (default: 5 years) */
  retentionDays: parseInt(process.env.EVIDENCE_RETENTION_DAYS || '1825', 10),

  /** Raw snapshot retention in days (default: 1 year) */
  snapshotRetentionDays: parseInt(process.env.SNAPSHOT_RETENTION_DAYS || '365', 10),

  /** Fetch log retention in days (default: 6 months) */
  logRetentionDays: parseInt(process.env.LOG_RETENTION_DAYS || '180', 10),
};
