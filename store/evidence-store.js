'use strict';

const fs = require('fs');
const path = require('path');

function createFileBackend(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const sub of ['lookups', 'recipes', 'evidence', 'coverage']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }

  function encodeKey(key) {
    return key.replace(/::/g, '__').replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  function readJson(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }

  function writeJson(filePath, obj) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  }

  function listJsonDir(sub) {
    try {
      return fs
        .readdirSync(path.join(dir, sub))
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson(path.join(dir, sub, f)))
        .filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  return { readJson, writeJson, encodeKey, listJsonDir, dir };
}

function createSqliteBackend(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(filePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lookups (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coverage (
      key TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
  `);

  const statements = {
    allCounters: db.prepare('SELECT name, value FROM counters'),
    upsertCounter: db.prepare(`
      INSERT INTO counters (name, value) VALUES (?, ?)
      ON CONFLICT(name) DO UPDATE SET value = excluded.value
    `),
    allLookups: db.prepare('SELECT id, payload FROM lookups'),
    saveLookup: db.prepare(`
      INSERT INTO lookups (id, payload) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `),
    allRecipes: db.prepare('SELECT id, payload FROM recipes'),
    saveRecipe: db.prepare(`
      INSERT INTO recipes (id, payload) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `),
    allEvidence: db.prepare('SELECT id, payload FROM evidence'),
    saveEvidence: db.prepare(`
      INSERT INTO evidence (id, payload) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `),
    allCoverage: db.prepare('SELECT key, payload FROM coverage'),
    saveCoverage: db.prepare(`
      INSERT INTO coverage (key, payload) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload
    `),
  };

  function parsePayload(value) {
    try {
      return JSON.parse(value);
    } catch (_) {
      return null;
    }
  }

  return {
    db,
    statements,
    parsePayload,
  };
}

/**
 * Creates a storage component for the evidence lookup service.
 *
 * @param {object} config  - Store configuration.
 * @param {string} [config.type='memory'] - 'memory', 'file', or 'sqlite'.
 * @param {string} [config.dir='.evidence-store'] - Base directory for file backend.
 * @param {string} [config.dbPath='.evidence-store/evidence-store.sqlite'] - SQLite database path.
 * @param {object} state   - The service's internal state object
 *                           ({ counters, lookups, recipes, evidence, coverage }).
 * @returns {object} Store with load(), saveCounters(), saveLookup(), saveRecipe(),
 *                   saveEvidence(), saveCoverage() methods.
 */
function createEvidenceStore(config, state) {
  const type = (config && config.type) || 'memory';

  if (type !== 'file') {
    if (type === 'sqlite') {
      const dbPath = (config && config.dbPath) || path.join('.evidence-store', 'evidence-store.sqlite');
      const backend = createSqliteBackend(dbPath);

      return {
        type: 'sqlite',
        dbPath,
        load() {
          for (const row of backend.statements.allCounters.all()) {
            if (Object.hasOwn(state.counters, row.name)) {
              state.counters[row.name] = row.value;
            }
          }

          for (const row of backend.statements.allLookups.all()) {
            const payload = backend.parsePayload(row.payload);
            if (payload && payload.lookupId) {
              state.lookups.set(payload.lookupId, payload);
            }
          }

          for (const row of backend.statements.allRecipes.all()) {
            const payload = backend.parsePayload(row.payload);
            if (payload && payload.recipeId) {
              state.recipes.set(payload.recipeId, payload);
            }
          }

          for (const row of backend.statements.allEvidence.all()) {
            const payload = backend.parsePayload(row.payload);
            if (payload && payload.id) {
              state.evidence.set(payload.id, payload);
            }
          }

          for (const row of backend.statements.allCoverage.all()) {
            const payload = backend.parsePayload(row.payload);
            if (payload) {
              state.coverage.set(row.key, payload);
            }
          }
        },
        saveCounters() {
          for (const [name, value] of Object.entries(state.counters)) {
            backend.statements.upsertCounter.run(name, value);
          }
        },
        saveLookup(id, obj) {
          state.lookups.set(id, obj);
          backend.statements.saveLookup.run(id, JSON.stringify(obj));
        },
        saveRecipe(id, obj) {
          state.recipes.set(id, obj);
          backend.statements.saveRecipe.run(id, JSON.stringify(obj));
        },
        saveEvidence(id, obj) {
          state.evidence.set(id, obj);
          backend.statements.saveEvidence.run(id, JSON.stringify(obj));
        },
        saveCoverage(key, obj) {
          state.coverage.set(key, obj);
          backend.statements.saveCoverage.run(key, JSON.stringify(obj));
        },
      };
    }

    return {
      type: 'memory',
      load() {},
      saveCounters() {},
      saveLookup(id, obj) { state.lookups.set(id, obj); },
      saveRecipe(id, obj) { state.recipes.set(id, obj); },
      saveEvidence(id, obj) { state.evidence.set(id, obj); },
      saveCoverage(key, obj) { state.coverage.set(key, obj); },
    };
  }

  const dir = (config && config.dir) || '.evidence-store';
  const backend = createFileBackend(dir);

  return {
    type: 'file',
    dir,

    /** Populates state from disk. Call once on service startup. */
    load() {
      const meta = backend.readJson(path.join(dir, 'meta.json'));
      if (meta) {
        Object.assign(state.counters, meta);
      }

      for (const lookup of backend.listJsonDir('lookups')) {
        if (lookup && lookup.lookupId) {
          state.lookups.set(lookup.lookupId, lookup);
        }
      }
      for (const recipe of backend.listJsonDir('recipes')) {
        if (recipe && recipe.recipeId) {
          state.recipes.set(recipe.recipeId, recipe);
        }
      }
      for (const evidence of backend.listJsonDir('evidence')) {
        if (evidence && evidence.id) {
          state.evidence.set(evidence.id, evidence);
        }
      }
      for (const coverage of backend.listJsonDir('coverage')) {
        if (coverage && coverage._key) {
          const { _key, ...rest } = coverage;
          state.coverage.set(_key, rest);
        }
      }
    },

    saveCounters() {
      backend.writeJson(path.join(dir, 'meta.json'), state.counters);
    },

    saveLookup(id, obj) {
      backend.writeJson(path.join(dir, 'lookups', `${id}.json`), obj);
    },

    saveRecipe(id, obj) {
      backend.writeJson(path.join(dir, 'recipes', `${id}.json`), obj);
    },

    saveEvidence(id, obj) {
      backend.writeJson(path.join(dir, 'evidence', `${id}.json`), obj);
    },

    saveCoverage(key, obj) {
      backend.writeJson(
        path.join(dir, 'coverage', `${backend.encodeKey(key)}.json`),
        { ...obj, _key: key }
      );
    },
  };
}

module.exports = { createEvidenceStore };
