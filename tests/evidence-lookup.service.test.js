const test = require("node:test");
const assert = require("node:assert/strict");
const { createEvidenceLookupService } = require("../services/evidence-lookup.service");

function buildSuccessfulDiscoveryService() {
  return createEvidenceLookupService({
    discoverySteps: {
      async search() {
        return {
          queries: ["Westnetz Redispatch 2.0 Massnahmen"],
          candidateUrls: ["https://westnetz.example/redispatch"],
        };
      },
      async classify() {
        return {
          sourceType: "vnb_html_table",
          officialUrls: ["https://westnetz.example/redispatch"],
        };
      },
      async parse() {
        return {
          adapter: "vnb-html-table",
          adapterVersion: "1.0.0",
          parserProfile: "westnetz.redispatch.public.v1",
          llmParseAttempts: 1,
          records: [
            {
              measure: {
                kind: "redispatch",
                status: "completed",
                startsAt: "2026-06-17T08:00:00Z",
                endsAt: "2026-06-17T09:00:00Z",
                powerMw: 12.4,
              },
              provenance: {
                rawSnapshotHash: "sha256:raw",
                canonicalJsonHash: "sha256:canonical",
              },
              quality: {
                warnings: ["not_connect_plus_source"],
              },
            },
          ],
        };
      },
      async validate() {
        return { valid: true, recipeStatus: "candidate", confidence: "medium" };
      },
    },
  });
}

test("lookup creates discovery job when no recipe exists", async () => {
  const service = createEvidenceLookupService();
  const response = await service.actions.lookup({
    params: {
      domain: "redispatch_2_0",
      operator: { id: "westnetz", name: "Westnetz GmbH" },
      mode: "discover_if_missing",
    },
  });

  assert.equal(response.status, "queued");
  assert.equal(response.recipeStatus, "missing");
  assert.equal(response.action, "discovery_started");
});

test("lookup reuses active recipe when present", async () => {
  const service = createEvidenceLookupService();
  service.__state.recipes.set("rdr_1", {
    recipeId: "rdr_1",
    domain: "redispatch_2_0",
    operatorId: "westnetz",
    status: "active",
  });

  const response = await service.actions.lookup({
    params: {
      domain: "redispatch_2_0",
      operator: { id: "westnetz", name: "Westnetz GmbH" },
    },
  });

  assert.equal(response.status, "completed");
  assert.equal(response.action, "recipe_reused");
  assert.equal(response.recipeId, "rdr_1");
});

test("discovery stores candidate recipe from official public source", async () => {
  const service = buildSuccessfulDiscoveryService();
  await service.actions.lookup({
    params: {
      domain: "redispatch_2_0",
      operator: { id: "westnetz", name: "Westnetz GmbH" },
      executeDiscovery: true,
    },
  });

  const recipes = await service.actions.listRecipes({
    params: { domain: "redispatch_2_0", operator: "westnetz" },
  });
  assert.equal(recipes.items.length, 1);
  assert.equal(recipes.items[0].status, "candidate");
  assert.equal(recipes.items[0].source.sourceType, "vnb_html_table");
});

test("discovery stores negative evidence when no public source is found", async () => {
  const service = createEvidenceLookupService({
    discoverySteps: {
      async classify() {
        return { sourceType: "vnb_html_table", officialUrls: [] };
      },
      async parse() {
        return { records: [], llmParseAttempts: 1 };
      },
      async validate() {
        return { valid: false, reason: "no_public_measure_list_found" };
      },
    },
  });

  await service.actions.lookup({
    params: {
      domain: "redispatch_2_0",
      operator: { id: "westnetz", name: "Westnetz GmbH" },
      executeDiscovery: true,
    },
  });

  const evidence = await service.actions.listEvidence({
    params: {
      domain: "redispatch_2_0",
      operator: "westnetz",
      evidenceType: "negative_evidence",
    },
  });
  assert.equal(evidence.items.length, 1);
  assert.equal(evidence.items[0].quality.warnings[0], "no_public_measure_list_found");
});

test("coverage returns no_public_measure_list_found for negative evidence", async () => {
  const service = createEvidenceLookupService({
    discoverySteps: {
      async parse() {
        return { records: [] };
      },
      async validate() {
        return { valid: false, reason: "no_public_measure_list_found" };
      },
    },
  });

  await service.actions.lookup({
    params: {
      domain: "redispatch_2_0",
      operator: { id: "westnetz", name: "Westnetz GmbH" },
      executeDiscovery: true,
    },
  });

  const coverage = await service.actions.getCoverage({
    params: { domain: "redispatch_2_0", operator: "westnetz" },
  });
  assert.equal(coverage.coverageStatus, "no_public_measure_list_found");
});

test("evidence records include provenance hashes and parser version", async () => {
  const service = buildSuccessfulDiscoveryService();
  await service.actions.lookup({
    params: {
      domain: "redispatch_2_0",
      operator: { id: "westnetz", name: "Westnetz GmbH" },
      executeDiscovery: true,
    },
  });

  const listed = await service.actions.listEvidence({
    params: { domain: "redispatch_2_0", operator: "westnetz", confidenceMin: "medium" },
  });
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0].provenance.rawSnapshotHash, "sha256:raw");
  assert.equal(listed.items[0].provenance.canonicalJsonHash, "sha256:canonical");
  assert.equal(listed.items[0].source.parserProfile, "westnetz.redispatch.public.v1");
  assert.equal(listed.items[0].source.adapterVersion, "1.0.0");
  assert.equal(Object.hasOwn(listed.items[0], "rawContent"), false);
});

test("degraded recipe is reported when parse validation fails", async () => {
  const service = createEvidenceLookupService({
    discoverySteps: {
      async parse() {
        return { records: [] };
      },
      async validate() {
        return { valid: false, reason: "parse_validation_failed" };
      },
    },
  });

  service.__state.recipes.set("rdr_active", {
    recipeId: "rdr_active",
    domain: "redispatch_2_0",
    operatorId: "westnetz",
    status: "active",
    updatedAt: "2026-06-17T10:00:00Z",
  });

  const lookup = await service.actions.lookup({
    params: {
      domain: "redispatch_2_0",
      operator: { id: "westnetz", name: "Westnetz GmbH" },
      executeDiscovery: true,
    },
  });

  const degradedRecipe = await service.actions.getRecipe({ params: { recipeId: "rdr_active" } });
  assert.equal(lookup.recipeStatus, "degraded");
  assert.equal(degradedRecipe.status, "degraded");
});
