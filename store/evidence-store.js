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

/**
 * Creates a storage component for the evidence lookup service.
 *
 * @param {object} config  - Store configuration.
 * @param {string} [config.type='memory'] - 'memory' or 'file'.
 * @param {string} [config.dir='.evidence-store'] - Base directory for file backend.
 * @param {object} state   - The service's internal state object
 *                           ({ counters, lookups, recipes, evidence, coverage }).
 * @returns {object} Store with load(), saveCounters(), saveLookup(), saveRecipe(),
 *                   saveEvidence(), saveCoverage() methods.
 */
function createEvidenceStore(config, state) {
  const type = (config && config.type) || 'memory';

  if (type !== 'file') {
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
