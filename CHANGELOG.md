# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`services/default-discovery.js`** – Real default discovery pipeline with search bootstrap, HTTP fetch, same-host crawling, HTML table scraping, JSON feed parsing, source classification, and LLM fallback support.
- **`services/llm-client.js`** – OpenAI-compatible LLM client for semantic extraction fallback with JSON-only responses and configurable endpoint/model settings.
- **SQLite store backend** – `store/evidence-store.js` now supports `type: 'sqlite'` using Node's built-in `node:sqlite` module for local persistent storage without external dependencies.
- **Expanded configuration/docs/tests** – Added discovery/LLM environment settings, SQLite examples, and regression coverage for default scraping + LLM fallback paths.

- **`store/evidence-store.js`** – Pluggable storage component with three backends:
  - `memory` (default): write-through in-memory Maps, no disk I/O. Suitable for tests and ephemeral processes.
  - `file`: write-through JSON file persistence under `EVIDENCE_STORE_DIR`. Recipes, evidence records, lookups, coverage data and ID counters survive process restarts. Each entity is stored as an individual `.json` file for simple inspection and backup.
  - `sqlite`: local write-through SQLite persistence under `EVIDENCE_STORE_DB_PATH`, implemented with Node's built-in `node:sqlite`.
  - Public API: `load()`, `saveCounters()`, `saveLookup(id, obj)`, `saveRecipe(id, obj)`, `saveEvidence(id, obj)`, `saveCoverage(key, obj)`.
- **`store/config.js`** – Centralised configuration loader. Reads from a `.env` file via `dotenv` (if present) and exports `type`, `dir`, `retentionDays`, `snapshotRetentionDays`, and `logRetentionDays` with documented defaults.
- **`.env.example`** – Documented example environment file with all configurable settings, ready to copy to `.env`.
- **`tests/evidence-store.test.js`** – Unit/integration coverage for all persistent backends, including full service-restart round-trip tests for file and SQLite persistence.
- **`dotenv`** (npm) – Runtime dependency for loading `.env` configuration files.

### Changed

- **`services/evidence-lookup.service.js`** – All state mutations now route through internal write-through helper functions (`setLookup`, `setRecipe`, `setEvidence`, `setCoverage`) and `nextId` calls `store.saveCounters()`. The service accepts an `options.storeConfig` parameter to inject a custom store configuration; if omitted the default config from `store/config.js` is used. Backward compatibility with existing tests (via `__state`) is fully preserved.
- **`package.json`** – Added `dotenv` as a runtime dependency.

## [1.0.0] – 2026-06-17

### Added

- **`services/evidence-lookup.service.js`** – MVP implementation of the Evidence Lookup Service with in-memory state, mockable discovery pipeline (`search`, `fetch`, `classify`, `parse`, `validate`), Redispatch 2.0 normalizer, stub adapters (`vnb_html_table`, `netztransparenz_api`), recipe lifecycle management (candidate → active → degraded) and the following Moleculer-style actions:
  - `lookup` – Start a lookup or reuse an active recipe.
  - `getLookup` – Read lookup status by ID.
  - `listRecipes` – Filter recipes by domain, operator and status.
  - `getRecipe` – Read a single recipe.
  - `updateRecipeStatus` – Patch recipe status (activate, retire, block).
  - `getCoverage` – Return the latest coverage status for an operator+domain.
  - `listEvidence` – Return normalised evidence records with optional filters.
  - `getEvidence` – Read a single evidence record.
- **`tests/evidence-lookup.service.test.js`** – 7 unit tests covering all acceptance criteria from the service specification.
- **`package.json`** – Project manifest; test command: `npm test` → `node --test`.
