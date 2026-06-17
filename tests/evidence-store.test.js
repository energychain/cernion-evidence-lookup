'use strict';

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createEvidenceStore } = require("../store/evidence-store");

function makeState() {
  return {
    counters: { lookup: 0, recipe: 0, evidence: 0 },
    lookups: new Map(),
    recipes: new Map(),
    evidence: new Map(),
    coverage: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Memory store tests
// ---------------------------------------------------------------------------

test("memory store: saveLookup writes to state", () => {
  const state = makeState();
  const store = createEvidenceStore({ type: "memory" }, state);
  store.load();

  const lookup = { lookupId: "rdl_1", status: "queued" };
  store.saveLookup("rdl_1", lookup);
  assert.deepEqual(state.lookups.get("rdl_1"), lookup);
});

test("memory store: saveRecipe writes to state", () => {
  const state = makeState();
  const store = createEvidenceStore({ type: "memory" }, state);
  store.load();

  const recipe = { recipeId: "rdr_1", domain: "redispatch_2_0", operatorId: "op1", status: "active" };
  store.saveRecipe("rdr_1", recipe);
  assert.deepEqual(state.recipes.get("rdr_1"), recipe);
});

test("memory store: saveEvidence writes to state", () => {
  const state = makeState();
  const store = createEvidenceStore({ type: "memory" }, state);
  store.load();

  const ev = { id: "rde_1", domain: "redispatch_2_0", operator: { id: "op1" }, quality: { confidence: "medium" } };
  store.saveEvidence("rde_1", ev);
  assert.deepEqual(state.evidence.get("rde_1"), ev);
});

test("memory store: saveCoverage writes to state", () => {
  const state = makeState();
  const store = createEvidenceStore({ type: "memory" }, state);
  store.load();

  const cov = { operator: { id: "op1" }, coverageStatus: "partial_public_sources" };
  store.saveCoverage("redispatch_2_0::op1", cov);
  assert.deepEqual(state.coverage.get("redispatch_2_0::op1"), cov);
});

test("memory store: saveCounters is a no-op (counters remain in state)", () => {
  const state = makeState();
  const store = createEvidenceStore({ type: "memory" }, state);
  state.counters.recipe = 5;
  assert.doesNotThrow(() => store.saveCounters());
  assert.equal(state.counters.recipe, 5);
});

test("memory store: load is a no-op", () => {
  const state = makeState();
  const store = createEvidenceStore({ type: "memory" }, state);
  assert.doesNotThrow(() => store.load());
  assert.equal(state.lookups.size, 0);
  assert.equal(state.recipes.size, 0);
});

// ---------------------------------------------------------------------------
// File store tests
// ---------------------------------------------------------------------------

test("file store: persists lookup to disk and loads it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-test-"));
  try {
    const state1 = makeState();
    const store1 = createEvidenceStore({ type: "file", dir }, state1);
    store1.load();
    const lookup = { lookupId: "rdl_1", status: "completed" };
    store1.saveLookup("rdl_1", lookup);

    const state2 = makeState();
    const store2 = createEvidenceStore({ type: "file", dir }, state2);
    store2.load();
    assert.deepEqual(state2.lookups.get("rdl_1"), lookup);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file store: persists recipe to disk and loads it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-test-"));
  try {
    const state1 = makeState();
    const store1 = createEvidenceStore({ type: "file", dir }, state1);
    store1.load();
    const recipe = { recipeId: "rdr_1", domain: "redispatch_2_0", operatorId: "op1", status: "candidate" };
    store1.saveRecipe("rdr_1", recipe);

    const state2 = makeState();
    const store2 = createEvidenceStore({ type: "file", dir }, state2);
    store2.load();
    assert.deepEqual(state2.recipes.get("rdr_1"), recipe);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file store: persists evidence to disk and loads it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-test-"));
  try {
    const state1 = makeState();
    const store1 = createEvidenceStore({ type: "file", dir }, state1);
    store1.load();
    const ev = {
      id: "rde_1",
      domain: "redispatch_2_0",
      operator: { id: "op1" },
      provenance: { rawSnapshotHash: "sha256:abc", canonicalJsonHash: "sha256:def" },
      quality: { confidence: "medium", warnings: [] },
    };
    store1.saveEvidence("rde_1", ev);

    const state2 = makeState();
    const store2 = createEvidenceStore({ type: "file", dir }, state2);
    store2.load();
    assert.deepEqual(state2.evidence.get("rde_1"), ev);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file store: persists coverage to disk and loads it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-test-"));
  try {
    const state1 = makeState();
    const store1 = createEvidenceStore({ type: "file", dir }, state1);
    store1.load();
    const cov = { operator: { id: "op1" }, coverageStatus: "no_public_measure_list_found" };
    store1.saveCoverage("redispatch_2_0::op1", cov);

    const state2 = makeState();
    const store2 = createEvidenceStore({ type: "file", dir }, state2);
    store2.load();
    const loaded = state2.coverage.get("redispatch_2_0::op1");
    assert.equal(loaded.coverageStatus, "no_public_measure_list_found");
    assert.equal(loaded.operator.id, "op1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file store: persists counters and restores them on reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-test-"));
  try {
    const state1 = makeState();
    const store1 = createEvidenceStore({ type: "file", dir }, state1);
    store1.load();
    state1.counters.recipe = 7;
    state1.counters.evidence = 3;
    store1.saveCounters();

    const state2 = makeState();
    const store2 = createEvidenceStore({ type: "file", dir }, state2);
    store2.load();
    assert.equal(state2.counters.recipe, 7);
    assert.equal(state2.counters.evidence, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file store: coverage _key field is stripped after reload", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-test-"));
  try {
    const state1 = makeState();
    const store1 = createEvidenceStore({ type: "file", dir }, state1);
    store1.load();
    store1.saveCoverage("redispatch_2_0::op1", { operator: { id: "op1" }, coverageStatus: "ok" });

    const state2 = makeState();
    const store2 = createEvidenceStore({ type: "file", dir }, state2);
    store2.load();
    const loaded = state2.coverage.get("redispatch_2_0::op1");
    assert.equal(Object.hasOwn(loaded, "_key"), false, "_key should be stripped from loaded coverage");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: service with file store survives restart
// ---------------------------------------------------------------------------

test("file store: service preserves recipes and evidence across restarts", async () => {
  const { createEvidenceLookupService } = require("../services/evidence-lookup.service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-svc-test-"));
  try {
    const svc1 = createEvidenceLookupService({
      storeConfig: { type: "file", dir },
      discoverySteps: {
        async classify() {
          return { sourceType: "vnb_html_table", officialUrls: ["https://example.invalid/rdr"] };
        },
        async parse() {
          return {
            adapter: "vnb-html-table",
            adapterVersion: "1.0.0",
            parserProfile: "testop.redispatch_2_0.public.v1",
            records: [
              {
                measure: { startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-01T01:00:00Z", powerMw: 5 },
                provenance: { rawSnapshotHash: "sha256:restart-r", canonicalJsonHash: "sha256:restart-c" },
              },
            ],
          };
        },
        async validate() {
          return { valid: true, recipeStatus: "candidate", confidence: "medium" };
        },
      },
    });

    await svc1.actions.lookup({
      params: {
        domain: "redispatch_2_0",
        operator: { id: "testop", name: "Test Op" },
        executeDiscovery: true,
      },
    });

    // Simulate service restart with fresh in-memory state loaded from disk
    const svc2 = createEvidenceLookupService({ storeConfig: { type: "file", dir } });

    const recipes = await svc2.actions.listRecipes({
      params: { domain: "redispatch_2_0", operator: "testop" },
    });
    assert.equal(recipes.items.length, 1);
    assert.equal(recipes.items[0].status, "candidate");

    const evidenceList = await svc2.actions.listEvidence({
      params: { domain: "redispatch_2_0", operator: "testop" },
    });
    assert.equal(evidenceList.items.length, 1);
    assert.equal(evidenceList.items[0].provenance.rawSnapshotHash, "sha256:restart-r");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite store: persists entities and counters to disk and loads them back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-sqlite-test-"));
  try {
    const dbPath = path.join(dir, "evidence.sqlite");
    const state1 = makeState();
    const store1 = createEvidenceStore({ type: "sqlite", dbPath }, state1);
    store1.load();

    state1.counters.recipe = 9;
    store1.saveCounters();
    store1.saveLookup("rdl_1", { lookupId: "rdl_1", status: "completed" });
    store1.saveRecipe("rdr_1", {
      recipeId: "rdr_1",
      domain: "redispatch_2_0",
      operatorId: "op1",
      status: "candidate",
    });
    store1.saveEvidence("rde_1", {
      id: "rde_1",
      domain: "redispatch_2_0",
      operator: { id: "op1" },
      provenance: { rawSnapshotHash: "sha256:a", canonicalJsonHash: "sha256:b" },
      quality: { confidence: "medium", warnings: [] },
    });
    store1.saveCoverage("redispatch_2_0::op1", {
      operator: { id: "op1" },
      coverageStatus: "partial_public_sources",
    });

    const state2 = makeState();
    const store2 = createEvidenceStore({ type: "sqlite", dbPath }, state2);
    store2.load();

    assert.equal(state2.counters.recipe, 9);
    assert.equal(state2.lookups.get("rdl_1").status, "completed");
    assert.equal(state2.recipes.get("rdr_1").status, "candidate");
    assert.equal(state2.evidence.get("rde_1").operator.id, "op1");
    assert.equal(state2.coverage.get("redispatch_2_0::op1").coverageStatus, "partial_public_sources");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("sqlite store: service preserves recipes and evidence across restarts", async () => {
  const { createEvidenceLookupService } = require("../services/evidence-lookup.service");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ev-store-sqlite-svc-test-"));
  try {
    const dbPath = path.join(dir, "evidence.sqlite");
    const svc1 = createEvidenceLookupService({
      storeConfig: { type: "sqlite", dbPath },
      discoverySteps: {
        async classify() {
          return { sourceType: "vnb_html_table", officialUrls: ["https://example.invalid/rdr"] };
        },
        async parse() {
          return {
            adapter: "vnb-html-table",
            adapterVersion: "1.0.0",
            parserProfile: "testop.redispatch_2_0.public.v1",
            records: [
              {
                measure: { startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-01T01:00:00Z", powerMw: 5 },
                provenance: { rawSnapshotHash: "sha256:sqlite-r", canonicalJsonHash: "sha256:sqlite-c" },
              },
            ],
          };
        },
        async validate() {
          return { valid: true, recipeStatus: "candidate", confidence: "medium" };
        },
      },
    });

    await svc1.actions.lookup({
      params: {
        domain: "redispatch_2_0",
        operator: { id: "testop", name: "Test Op" },
        executeDiscovery: true,
      },
    });

    const svc2 = createEvidenceLookupService({ storeConfig: { type: "sqlite", dbPath } });
    const recipes = await svc2.actions.listRecipes({
      params: { domain: "redispatch_2_0", operator: "testop" },
    });
    const evidenceList = await svc2.actions.listEvidence({
      params: { domain: "redispatch_2_0", operator: "testop" },
    });
    const lookup = await svc2.actions.getLookup({ params: { lookupId: "rdl_000001" } });

    assert.equal(recipes.items.length, 1);
    assert.equal(recipes.items[0].status, "candidate");
    assert.equal(evidenceList.items.length, 1);
    assert.equal(evidenceList.items[0].provenance.rawSnapshotHash, "sha256:sqlite-r");
    assert.equal(lookup.status, "completed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
