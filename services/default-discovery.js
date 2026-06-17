'use strict';

const { createLlmClient } = require('./llm-client');

const DEFAULT_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MAX_SEARCH_RESULTS = 5;
const DOMAIN_KEYWORDS = ['redispatch', 'maßnahme', 'massnahme', 'engpass', 'measure'];

function unique(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function stripTags(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(nbsp|amp|quot|#39|lt|gt);/gi, (_, entity) => {
      const normalized = entity.toLowerCase();
      if (normalized === 'nbsp') return ' ';
      if (normalized === 'amp') return '&';
      if (normalized === 'quot') return '"';
      if (normalized === '#39') return "'";
      if (normalized === 'lt') return '<';
      if (normalized === 'gt') return '>';
      return ' ';
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitle(html) {
  const match = typeof html === 'string' ? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) : null;
  return stripTags(match?.[1] || '');
}

function looksLikeHtml(contentType, body) {
  return /html/i.test(contentType || '') || /<html|<table|<body/i.test(body || '');
}

function looksLikeJson(contentType, body) {
  return /json/i.test(contentType || '') || /^\s*[\[{]/.test(body || '');
}

function ensureUrl(value, baseUrl) {
  try {
    return new URL(value, baseUrl).toString();
  } catch (_) {
    return null;
  }
}

function extractLinks(html, baseUrl) {
  const matches = typeof html === 'string'
    ? html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>/gi)
    : [];
  return unique(Array.from(matches, (match) => ensureUrl(match[1], baseUrl)));
}

function parseSearchResultLinks(html, baseUrl) {
  return extractLinks(html, baseUrl).filter((url) => /^https?:/i.test(url));
}

function buildSearchQueries({ operator, domain }) {
  const operatorName = operator?.name || operator?.id || 'operator';
  if (domain === 'redispatch_2_0') {
    return [
      `${operatorName} Redispatch 2.0 Maßnahmen`,
      `${operatorName} redispatch netzbetreiber`,
    ];
  }
  return [`${operatorName} ${domain}`];
}

function collectSeedUrls(operator) {
  const seeds = [
    operator?.website,
    operator?.homepage,
    operator?.sourceUrl,
    operator?.redispatchUrl,
    ...(Array.isArray(operator?.urls) ? operator.urls : []),
    ...(Array.isArray(operator?.sourceUrls) ? operator.sourceUrls : []),
  ];
  return unique(seeds.map((value) => ensureUrl(value)));
}

function scorePage(page, operator) {
  const url = page?.url || '';
  const title = page?.title || '';
  const text = stripTags(page?.body || '');
  let score = 0;

  for (const keyword of DOMAIN_KEYWORDS) {
    if (new RegExp(keyword, 'i').test(url)) score += 3;
    if (new RegExp(keyword, 'i').test(title)) score += 2;
    if (new RegExp(keyword, 'i').test(text)) score += 1;
  }

  const operatorNeedle = operator?.name || operator?.id;
  if (operatorNeedle && new RegExp(operatorNeedle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) {
    score += 2;
  }

  if (/<table/i.test(page?.body || '')) score += 4;
  if (looksLikeJson(page?.contentType, page?.body)) score += 4;

  const seedUrl = operator?.website || operator?.homepage || operator?.sourceUrl || operator?.redispatchUrl;
  if (seedUrl) {
    try {
      const expectedHost = new URL(seedUrl).hostname;
      if (new URL(url).hostname === expectedHost) score += 3;
    } catch (_) {}
  }

  return score;
}

function guessSourceType(page) {
  return looksLikeJson(page?.contentType, page?.body) ? 'netztransparenz_api' : 'vnb_html_table';
}

function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized) return null;

  const iso = Date.parse(normalized);
  if (!Number.isNaN(iso)) {
    return new Date(iso).toISOString();
  }

  const european = normalized.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!european) return null;

  const [, day, month, year, hour = '00', minute = '00', second = '00'] = european;
  const fullYear = year.length === 2 ? `20${year}` : year;
  return new Date(
    Date.UTC(Number(fullYear), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  ).toISOString();
}

function normalizeNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed
    .replace(/\s+/g, '')
    .replace(/\.(?=\d{3}(?:\D|$))/g, '')
    .replace(',', '.')
    .replace(/[^0-9.-]/g, '');

  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractTableRows(html) {
  const tables = typeof html === 'string' ? html.match(/<table[\s\S]*?<\/table>/gi) || [] : [];
  return tables.map((table) => {
    const rows = table.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    return rows.map((row) => {
      const cells = row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || [];
      return cells.map((cell) => stripTags(cell));
    });
  });
}

function headerIndex(headers, expressions) {
  return headers.findIndex((header) => expressions.some((expression) => expression.test(header)));
}

function looksLikeHeaderRow(headers) {
  const normalizedHeaders = headers.map((cell) => cell.toLowerCase());
  return normalizedHeaders.some((header) =>
    [/von/, /bis/, /start/, /ende/, /mw/, /leistung/, /status/, /richtung/, /direction/].some((pattern) =>
      pattern.test(header)
    )
  );
}

function recordsFromTable(tableRows) {
  if (!Array.isArray(tableRows) || tableRows.length < 2) return [];
  if (!looksLikeHeaderRow(tableRows[0])) return [];

  const headers = tableRows[0].map((cell) => cell.toLowerCase());
  const startsAtIndex = headerIndex(headers, [/^von$/, /start/, /beginn/, /ab /, /ab$/]);
  const endsAtIndex = headerIndex(headers, [/^bis$/, /ende/, /end/, /to$/]);
  const powerIndex = headerIndex(headers, [/mw/, /leistung/, /power/]);
  const statusIndex = headerIndex(headers, [/status/]);
  const directionIndex = headerIndex(headers, [/richtung/, /direction/]);
  const energyIndex = headerIndex(headers, [/mwh/, /arbeit/, /energy/]);

  if (startsAtIndex === -1 && powerIndex === -1) return [];

  return tableRows.slice(1).map((cells) => {
    const startsAt = normalizeDate(cells[startsAtIndex]);
    const endsAt = normalizeDate(cells[endsAtIndex]);
    const powerMw = normalizeNumber(cells[powerIndex]);
    const energyMwh = normalizeNumber(cells[energyIndex]);

    return {
      measure: {
        kind: 'redispatch',
        startsAt,
        endsAt,
        powerMw,
        energyMwh,
        status: cells[statusIndex] || 'unknown',
        direction: cells[directionIndex] || 'unknown',
      },
      quality: {
        warnings: [],
      },
    };
  }).filter((record) => record.measure.startsAt || record.measure.powerMw !== null);
}

function parseJsonRecords(body) {
  try {
    const parsed = JSON.parse(body);
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.records) ? parsed.records : [];
    return items.map((item) => ({
      ...item,
      measure: {
        ...(item?.measure || {}),
        startsAt: normalizeDate(item?.measure?.startsAt || item?.startsAt),
        endsAt: normalizeDate(item?.measure?.endsAt || item?.endsAt),
        powerMw: normalizeNumber(item?.measure?.powerMw ?? item?.powerMw),
        energyMwh: normalizeNumber(item?.measure?.energyMwh ?? item?.energyMwh),
      },
      quality: {
        warnings: Array.isArray(item?.quality?.warnings) ? item.quality.warnings : [],
      },
    }));
  } catch (_) {
    return [];
  }
}

async function fetchUrl(url, config, fetchImplementation) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(config.fetchTimeoutMs || DEFAULT_FETCH_TIMEOUT_MS));

  try {
    const response = await fetchImplementation(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'user-agent': config.userAgent || 'cernion-evidence-lookup/1.0',
        accept: 'text/html,application/json,text/plain;q=0.9,*/*;q=0.8',
      },
    });

    const body = await response.text();
    const contentType = response.headers?.get?.('content-type') || '';

    return {
      url,
      ok: response.ok,
      status: response.status,
      contentType,
      body,
      title: extractTitle(body),
      links: looksLikeHtml(contentType, body) ? extractLinks(body, url) : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

function createDefaultDiscoverySteps(options = {}) {
  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const llmClient = options.llmClient || createLlmClient(options.llmConfig || {}, { fetchImplementation });
  const config = {
    maxPages: Number(options.discoveryConfig?.maxPages || process.env.EVIDENCE_FETCH_MAX_PAGES || DEFAULT_MAX_PAGES),
    maxSearchResults: Number(
      options.discoveryConfig?.maxSearchResults
      || process.env.EVIDENCE_SEARCH_MAX_RESULTS
      || DEFAULT_MAX_SEARCH_RESULTS
    ),
    fetchTimeoutMs: Number(
      options.discoveryConfig?.fetchTimeoutMs
      || process.env.EVIDENCE_FETCH_TIMEOUT_MS
      || DEFAULT_FETCH_TIMEOUT_MS
    ),
    searchEndpoint:
      options.discoveryConfig?.searchEndpoint
      || process.env.EVIDENCE_SEARCH_ENDPOINT
      || 'https://duckduckgo.com/html/?q=',
    userAgent: options.discoveryConfig?.userAgent || process.env.EVIDENCE_FETCH_USER_AGENT,
  };

  return {
    async search(input) {
      const queries = buildSearchQueries(input);
      const candidateUrls = [...collectSeedUrls(input.operator)];

      if (!fetchImplementation) {
        return { queries, candidateUrls };
      }

      for (const query of queries) {
        if (candidateUrls.length >= config.maxSearchResults) break;
        try {
          const searchUrl = `${config.searchEndpoint}${encodeURIComponent(query)}`;
          const page = await fetchUrl(searchUrl, config, fetchImplementation);
          candidateUrls.push(
            ...parseSearchResultLinks(page.body, config.searchEndpoint).slice(0, config.maxSearchResults)
          );
        } catch (_) {}
      }

      return {
        queries,
        candidateUrls: unique(candidateUrls).slice(0, config.maxSearchResults),
      };
    },

    async fetch(input) {
      if (!fetchImplementation) {
        return { pages: [] };
      }

      const queue = [...(input.searchResult?.candidateUrls || [])];
      const pages = [];
      const visited = new Set();

      while (queue.length > 0 && pages.length < config.maxPages) {
        const url = queue.shift();
        if (!url || visited.has(url)) continue;
        visited.add(url);

        try {
          const page = await fetchUrl(url, config, fetchImplementation);
          pages.push(page);

          const sameHostLinks = page.links.filter((link) => {
            try {
              return new URL(link).hostname === new URL(url).hostname;
            } catch (_) {
              return false;
            }
          });

          for (const link of sameHostLinks) {
            if (DOMAIN_KEYWORDS.some((keyword) => new RegExp(keyword, 'i').test(link))) {
              queue.push(link);
            }
          }
        } catch (_) {}
      }

      return { pages };
    },

    async classify(input) {
      const rankedPages = [...(input.fetchResult?.pages || [])]
        .map((page) => ({ page, score: scorePage(page, input.operator) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score);

      const officialPages = rankedPages.slice(0, 3).map((entry) => entry.page);
      return {
        sourceType: guessSourceType(officialPages[0]),
        officialUrls: officialPages.map((page) => page.url),
      };
    },

    async parse(input) {
      const officialUrlSet = new Set(input.classifyResult?.officialUrls || []);
      const pages = (input.fetchResult?.pages || []).filter((page) => officialUrlSet.has(page.url));
      let llmParseAttempts = 0;

      for (const page of pages) {
        const deterministicRecords = looksLikeJson(page.contentType, page.body)
          ? parseJsonRecords(page.body)
          : extractTableRows(page.body).flatMap(recordsFromTable);

        if (deterministicRecords.length > 0) {
          return {
            adapter: looksLikeJson(page.contentType, page.body) ? 'netztransparenz-api' : 'vnb-html-table',
            adapterVersion: '1.0.0',
            parserProfile: `${input.operator.id}.${input.domain}.public.v1`,
            llmParseAttempts,
            records: deterministicRecords,
          };
        }

        const llmResult = await llmClient.extractRecords({
          domain: input.domain,
          operator: input.operator,
          page,
        });
        if (llmResult.attempted) {
          llmParseAttempts += 1;
        }
        if (Array.isArray(llmResult.records) && llmResult.records.length > 0) {
          return {
            adapter: 'llm-structured-extractor',
            adapterVersion: '1.0.0',
            parserProfile: `${input.operator.id}.${input.domain}.llm.v1`,
            llmParseAttempts,
            records: llmResult.records,
          };
        }
      }

      return {
        adapter: 'vnb-html-table',
        adapterVersion: '1.0.0',
        parserProfile: `${input.operator.id}.${input.domain}.public.v1`,
        llmParseAttempts,
        records: [],
      };
    },

    async validate({ parseResult }) {
      const validRecords = Array.isArray(parseResult?.records)
        ? parseResult.records.filter((record) => {
            const measure = record?.measure || {};
            return Boolean(measure.startsAt || measure.endsAt || measure.powerMw !== null);
          })
        : [];

      return {
        valid: validRecords.length > 0,
        reason: validRecords.length > 0 ? 'ok' : 'no_public_measure_list_found',
      };
    },
  };
}

module.exports = {
  createDefaultDiscoverySteps,
};
