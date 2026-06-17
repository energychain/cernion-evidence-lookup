'use strict';

const DEFAULT_TIMEOUT_MS = 30_000;

function stripCodeFence(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function extractJsonBlock(value) {
  const cleaned = stripCodeFence(value);
  const match = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  return match ? match[0] : cleaned;
}

function parseChatCompletionContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        return part?.text || '';
      })
      .join('\n');
  }
  return typeof content === 'string' ? content : '';
}

function parseJsonResponse(value) {
  if (!value) return null;
  try {
    return JSON.parse(extractJsonBlock(value));
  } catch (_) {
    return null;
  }
}

function trimPageContent(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function resolveEndpoint(config) {
  if (config.endpoint) return config.endpoint;
  if (!config.baseUrl) return null;
  return `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
}

function createLlmClient(config = {}, options = {}) {
  const fetchImplementation = options.fetchImplementation || globalThis.fetch;
  const resolvedConfig = {
    baseUrl: config.baseUrl || process.env.LLM_BASE_URL,
    endpoint: config.endpoint || process.env.LLM_ENDPOINT,
    model: config.model || process.env.LLM_MODEL,
    apiKey: config.apiKey || process.env.LLM_API_KEY,
    timeoutMs: Number(config.timeoutMs || process.env.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    maxInputChars: Number(config.maxInputChars || process.env.LLM_MAX_INPUT_CHARS || 12_000),
  };
  const timeoutMs = resolvedConfig.timeoutMs;
  const endpoint = resolveEndpoint(resolvedConfig);

  return {
    isConfigured() {
      return Boolean(fetchImplementation && endpoint && resolvedConfig.model);
    },

    async extractRecords({ domain, operator, page }) {
      if (!this.isConfigured()) {
        return {
          used: false,
          attempted: false,
          records: [],
          warnings: ['llm_not_configured'],
        };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetchImplementation(endpoint, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            ...(resolvedConfig.apiKey
              ? { authorization: ['Bearer', resolvedConfig.apiKey].join(' ') }
              : {}),
          },
          body: JSON.stringify({
            model: resolvedConfig.model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content:
                  'Extract structured evidence records from public energy-sector source material. Return JSON only with a top-level "records" array and optional "warnings" array.',
              },
              {
                role: 'user',
                content: JSON.stringify({
                  domain,
                  operator,
                  url: page?.url || null,
                  title: page?.title || null,
                  contentType: page?.contentType || null,
                  bodyExcerpt: trimPageContent(page?.body || '', resolvedConfig.maxInputChars),
                }),
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`LLM request failed with status ${response.status}`);
        }

        const payload = await response.json();
        const parsed = parseJsonResponse(parseChatCompletionContent(payload)) || {};
        const records = Array.isArray(parsed.records) ? parsed.records : [];

        return {
          used: true,
          attempted: true,
          records,
          warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
          model: resolvedConfig.model,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = {
  createLlmClient,
};
