'use strict';

const crypto = require("crypto");
const { createEvidenceStore } = require("../store/evidence-store");
const storeConfig = require("../store/config");
const { createDefaultDiscoverySteps } = require("./default-discovery");

const CONFIDENCE_ORDER = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
};

function sha256(input) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(typeof input === "string" ? input : JSON.stringify(input))
    .digest("hex")}`;
}

function redispatchNormalizer(record, context) {
  const startsAt = record?.measure?.startsAt || record?.startsAt || null;
  const endsAt = record?.measure?.endsAt || record?.endsAt || null;
  const powerMw = record?.measure?.powerMw ?? record?.powerMw ?? null;

  return {
    evidenceType: record?.evidenceType || "measure",
    operator: {
      id: context.operator.id,
      name: context.operator.name || context.operator.id,
      role: record?.operator?.role || "VNB",
    },
    measure: {
      kind: record?.measure?.kind || "redispatch",
      direction: record?.measure?.direction || "unknown",
      status: record?.measure?.status || "unknown",
      startsAt,
      endsAt,
      powerMw,
      energyMwh: record?.measure?.energyMwh ?? null,
    },
    source: {
      sourceId: context.recipe.source.sourceId,
      sourceType: context.recipe.source.sourceType,
      url: context.recipe.source.url,
      retrievedAt: context.now(),
      adapter: context.recipe.parse.adapter,
      adapterVersion: context.recipe.parse.adapterVersion,
      parserProfile: context.recipe.parse.parserProfile,
    },
    provenance: {
      rawSnapshotHash: record?.provenance?.rawSnapshotHash || sha256(record),
      canonicalJsonHash:
        record?.provenance?.canonicalJsonHash || sha256({ startsAt, endsAt, powerMw }),
    },
    quality: {
      confidence: context.recipe.confidence || "medium",
      confidenceScore: record?.quality?.confidenceScore ?? null,
      warnings: Array.isArray(record?.quality?.warnings) ? record.quality.warnings : [],
    },
  };
}

function createEvidenceLookupService(options = {}) {
  const now = options.now || (() => new Date().toISOString());

  const state = {
    counters: { lookup: 0, recipe: 0, evidence: 0 },
    lookups: new Map(),
    recipes: new Map(),
    evidence: new Map(),
    coverage: new Map(),
  };

  const store = createEvidenceStore(
    options.storeConfig || storeConfig,
    state
  );
  store.load();

  const domainNormalizers = {
    redispatch_2_0: redispatchNormalizer,
    ...(options.domainNormalizers || {}),
  };

  const defaultDiscoverySteps = createDefaultDiscoverySteps({
    discoveryConfig: options.discoveryConfig,
    fetchImplementation: options.fetchImplementation,
    llmClient: options.llmClient,
    llmConfig: options.llmConfig,
  });

  const discoverySteps = {
    ...defaultDiscoverySteps,
    ...(options.discoverySteps || {}),
  };

  function nextId(prefix, key) {
    state.counters[key] += 1;
    store.saveCounters();
    return `${prefix}_${String(state.counters[key]).padStart(6, "0")}`;
  }

  function recipeKey(domain, operatorId) {
    return `${domain}::${operatorId}`;
  }

  function setLookup(id, obj) {
    state.lookups.set(id, obj);
    store.saveLookup(id, obj);
  }

  function setRecipe(id, obj) {
    state.recipes.set(id, obj);
    store.saveRecipe(id, obj);
  }

  function setEvidence(id, obj) {
    state.evidence.set(id, obj);
    store.saveEvidence(id, obj);
  }

  function setCoverage(key, obj) {
    state.coverage.set(key, obj);
    store.saveCoverage(key, obj);
  }

  function findRecipes(filter = {}) {
    return Array.from(state.recipes.values()).filter((recipe) => {
      if (filter.domain && recipe.domain !== filter.domain) return false;
      if (filter.operatorId && recipe.operatorId !== filter.operatorId) return false;
      if (filter.status && recipe.status !== filter.status) return false;
      return true;
    });
  }

  function findActiveRecipe(domain, operatorId) {
    return findRecipes({ domain, operatorId, status: "active" })[0] || null;
  }

  function persistCoverage(domain, operator, data) {
    const key = recipeKey(domain, operator.id);
    const payload = {
      operator: { id: operator.id, name: operator.name || operator.id },
      checkedAt: now(),
      ...data,
    };
    setCoverage(key, payload);
    return payload;
  }

  async function persistPositiveEvidence({ domain, operator, recipe, parseResult }) {
    const normalizer = domainNormalizers[domain] || ((record) => record);
    const created = [];
    for (const parsedRecord of parseResult.records) {
      const normalized = normalizer(parsedRecord, { domain, operator, recipe, now });
      const id = nextId("rde", "evidence");
      const evidence = {
        id,
        schemaVersion: "1.0",
        domain,
        ...normalized,
      };
      setEvidence(id, evidence);
      created.push(evidence);
    }

    persistCoverage(domain, operator, {
      coverageStatus: "partial_public_sources",
      confidence: recipe.confidence || "medium",
      sourcesChecked: [
        {
          sourceId: recipe.source.sourceId,
          sourceType: recipe.source.sourceType,
          result: "ok",
          url: recipe.source.url,
          rawSnapshotHash: created[0]?.provenance?.rawSnapshotHash || null,
        },
      ],
      statement: "Public source provided normalizable evidence.",
      recommendedUse: "benchmark_gap_signal",
    });

    return created;
  }

  function persistNegativeEvidence({ domain, operator, classifyResult, reason }) {
    const id = nextId("rde", "evidence");
    const sourceUrl = classifyResult?.officialUrls?.[0] || null;
    const sourceType = classifyResult?.sourceType || "vnb_html_table";
    const evidence = {
      id,
      schemaVersion: "1.0",
      domain,
      evidenceType: "negative_evidence",
      operator: { id: operator.id, name: operator.name || operator.id, role: "VNB" },
      source: {
        sourceId: `${operator.id}-redispatch-info-page`,
        sourceType,
        url: sourceUrl,
        retrievedAt: now(),
        adapter: "vnb-html-table",
        adapterVersion: "1.0.0",
        parserProfile: `${operator.id}.${domain}.negative.v1`,
      },
      provenance: {
        rawSnapshotHash: sha256({ domain, operator: operator.id, sourceUrl, reason }),
        canonicalJsonHash: sha256({ domain, operator: operator.id, reason }),
      },
      quality: {
        confidence: "medium",
        confidenceScore: null,
        warnings: [reason || "no_public_measure_list_found"],
      },
    };
    setEvidence(id, evidence);

    persistCoverage(domain, operator, {
      coverageStatus: "no_public_measure_list_found",
      confidence: "medium",
      sourcesChecked: [
        {
          sourceId: evidence.source.sourceId,
          sourceType: evidence.source.sourceType,
          result: reason || "no_measure_table_found",
          url: evidence.source.url,
          rawSnapshotHash: evidence.provenance.rawSnapshotHash,
        },
      ],
      statement:
        "No public machine-readable redispatch measure list was found for this operator.",
      recommendedUse: "benchmark_gap_signal",
    });

    return evidence;
  }

  async function executeDiscovery(input) {
    const lookup = state.lookups.get(input.lookupId);
    if (!lookup) return null;

    const operator = {
      id: input.operator.id || input.operatorId,
      name: input.operator.name || input.operator.id || input.operatorId,
    };

    const searchResult = await discoverySteps.search({ ...input, operator });
    const fetchResult = await discoverySteps.fetch({ ...input, operator, searchResult });
    const classifyResult = await discoverySteps.classify({
      ...input,
      operator,
      searchResult,
      fetchResult,
    });
    const parseResult = await discoverySteps.parse({
      ...input,
      operator,
      searchResult,
      fetchResult,
      classifyResult,
    });
    const validationResult = await discoverySteps.validate({
      ...input,
      operator,
      searchResult,
      fetchResult,
      classifyResult,
      parseResult,
    });

    const activeRecipe = findActiveRecipe(input.domain, operator.id);
    const canPersistPositive = Boolean(validationResult?.valid);

    if (canPersistPositive) {
      const recipeId = validationResult.recipeId || nextId("rdr", "recipe");
      const recipe = {
        recipeId,
        domain: input.domain,
        operatorId: operator.id,
        status: validationResult.recipeStatus || "candidate",
        confidence: validationResult.confidence || "medium",
        discoveryMethod: "autodiscovered",
        createdAt: now(),
        updatedAt: now(),
        source: {
          sourceId: validationResult.sourceId || `${operator.id}-public-${input.domain}`,
          sourceType: classifyResult?.sourceType || "vnb_html_table",
          url: classifyResult?.officialUrls?.[0] || null,
          requiresAuthentication: false,
        },
        fetch: {
          method: "GET",
          headers: {},
          schedule: "0 */6 * * *",
        },
        parse: {
          adapter: parseResult.adapter || "vnb-html-table",
          adapterVersion: parseResult.adapterVersion || "1.0.0",
          parserProfile:
            parseResult.parserProfile || `${operator.id}.${input.domain}.public.v1`,
        },
        validation: {
          requiredFields: [
            "measure.startsAt",
            "source.url",
            "provenance.rawSnapshotHash",
          ],
          sampleEvidenceIds: [],
          lastValidatedAt: now(),
        },
      };

      setRecipe(recipe.recipeId, recipe);
      const createdEvidence = await persistPositiveEvidence({
        domain: input.domain,
        operator,
        recipe,
        parseResult,
      });

      recipe.validation.sampleEvidenceIds = createdEvidence.map((item) => item.id);
      recipe.updatedAt = now();
      setRecipe(recipe.recipeId, recipe);

      Object.assign(lookup, {
        status: "completed",
        recipeStatus: recipe.status,
        recipeId: recipe.recipeId,
        evidenceCreated: createdEvidence.length,
        coverageStatus: "partial_public_sources",
      });
    } else {
      if (activeRecipe) {
        activeRecipe.status = "degraded";
        activeRecipe.updatedAt = now();
        setRecipe(activeRecipe.recipeId, activeRecipe);
        lookup.recipeStatus = "degraded";
        lookup.recipeId = activeRecipe.recipeId;
      }

      persistNegativeEvidence({
        domain: input.domain,
        operator,
        classifyResult,
        reason: validationResult?.reason || "no_public_measure_list_found",
      });

      Object.assign(lookup, {
        status: "completed",
        evidenceCreated: 0,
        coverageStatus: "no_public_measure_list_found",
      });
    }

    lookup.discoveryTrace = {
      queries: searchResult?.queries || [],
      candidateUrls: (searchResult?.candidateUrls || []).length,
      officialUrls: (classifyResult?.officialUrls || []).length,
      llmParseAttempts: parseResult?.llmParseAttempts ?? 0,
    };
    setLookup(lookup.lookupId, lookup);
    return lookup;
  }

  function filterEvidence(params = {}) {
    return Array.from(state.evidence.values())
      .filter((item) => {
        if (params.domain && item.domain !== params.domain) return false;
        if (params.operator && item.operator?.id !== params.operator) return false;
        if (params.evidenceType && item.evidenceType !== params.evidenceType) return false;
        if (params.confidenceMin) {
          const itemScore = CONFIDENCE_ORDER[item.quality?.confidence || "none"] || 0;
          const minScore = CONFIDENCE_ORDER[params.confidenceMin] || 0;
          if (itemScore < minScore) return false;
        }
        return true;
      })
      .map((item) => JSON.parse(JSON.stringify(item)));
  }

  const service = {
    name: "evidence-lookup",
    adapters: {
      vnb_html_table: { id: "vnb-html-table", version: "1.0.0" },
      netztransparenz_api: { id: "netztransparenz-api", version: "1.0.0" },
    },
    registerDomainNormalizer(domain, normalizer) {
      domainNormalizers[domain] = normalizer;
    },
    executeDiscovery,
    __state: state,
    actions: {
      async lookup(ctx) {
        const params = ctx?.params || {};
        const domain = params.domain;
        const operator = params.operator || { id: params.operatorId };
        const operatorId = operator.id || params.operatorId;

        const activeRecipe = findActiveRecipe(domain, operatorId);
        if (activeRecipe && !params.executeDiscovery) {
          return {
            lookupId: nextId("rdl", "lookup"),
            status: "completed",
            domain,
            operatorId,
            recipeStatus: "active",
            recipeId: activeRecipe.recipeId,
            action: "recipe_reused",
          };
        }

        const lookup = {
          lookupId: nextId("rdl", "lookup"),
          status: "queued",
          domain,
          operatorId,
          recipeStatus: "missing",
          action: "discovery_started",
        };
        setLookup(lookup.lookupId, lookup);

        if (params.executeDiscovery) {
          return executeDiscovery({
            lookupId: lookup.lookupId,
            domain,
            operator,
            mode: params.mode || "discover_if_missing",
          });
        }

        return lookup;
      },

      async getLookup(ctx) {
        return state.lookups.get(ctx?.params?.lookupId) || null;
      },

      async listRecipes(ctx) {
        const params = ctx?.params || {};
        return {
          items: findRecipes({
            domain: params.domain,
            operatorId: params.operator || params.operatorId,
            status: params.status,
          }),
        };
      },

      async getRecipe(ctx) {
        return state.recipes.get(ctx?.params?.recipeId) || null;
      },

      async updateRecipeStatus(ctx) {
        const params = ctx?.params || {};
        const recipe = state.recipes.get(params.recipeId);
        if (!recipe) return null;
        recipe.status = params.status;
        recipe.reason = params.reason;
        recipe.updatedAt = now();
        setRecipe(recipe.recipeId, recipe);
        return recipe;
      },

      async getCoverage(ctx) {
        const params = ctx?.params || {};
        const domain = params.domain;
        const operatorId = params.operator || params.operatorId;
        return (
          state.coverage.get(recipeKey(domain, operatorId)) || {
            operator: { id: operatorId, name: operatorId },
            coverageStatus: "unknown",
            confidence: "none",
            checkedAt: now(),
            sourcesChecked: [],
            statement: "No coverage information available.",
            recommendedUse: "benchmark_gap_signal",
          }
        );
      },

      async listEvidence(ctx) {
        const params = ctx?.params || {};
        return {
          items: filterEvidence({
            domain: params.domain,
            operator: params.operator || params.operatorId,
            evidenceType: params.evidenceType,
            confidenceMin: params.confidenceMin || "none",
          }),
          nextCursor: null,
        };
      },

      async getEvidence(ctx) {
        const id = ctx?.params?.id || ctx?.params?.evidenceId;
        return state.evidence.get(id) || null;
      },
    },
  };

  return service;
}

module.exports = {
  createEvidenceLookupService,
};
