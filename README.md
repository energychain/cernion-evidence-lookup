# cernion-evidence-lookup
Generic evidence lookup service for discovering, normalizing, and preserving provenance of public energy-sector data sources.

## Current capabilities

- Real discovery pipeline for public web sources:
  - web search bootstrap via `EVIDENCE_SEARCH_ENDPOINT`
  - HTTP fetch + same-host crawl for candidate pages
  - HTML table scraping and JSON feed parsing
- Configurable LLM fallback for pages that need semantic extraction
- Pluggable persistence backends:
  - `memory`
  - `file`
  - `sqlite` (local database, no external dependency)

## Configuration

Copy `.env.example` to `.env` and adjust the values you need.

### Store backends

- `EVIDENCE_STORE_TYPE=memory|file|sqlite`
- `EVIDENCE_STORE_DIR=.evidence-store`
- `EVIDENCE_STORE_DB_PATH=.evidence-store/evidence-store.sqlite`

### Discovery / fetch

- `EVIDENCE_SEARCH_ENDPOINT=https://duckduckgo.com/html/?q=`
- `EVIDENCE_SEARCH_MAX_RESULTS=5`
- `EVIDENCE_FETCH_MAX_PAGES=5`
- `EVIDENCE_FETCH_TIMEOUT_MS=20000`
- `EVIDENCE_FETCH_USER_AGENT=cernion-evidence-lookup/1.0`

### LLM fallback

- `LLM_BASE_URL=https://api.openai.com/v1`
- `LLM_ENDPOINT=` (optional; overrides `LLM_BASE_URL + /chat/completions`)
- `LLM_MODEL=`
- `LLM_API_KEY=`
- `LLM_TIMEOUT_MS=30000`
- `LLM_MAX_INPUT_CHARS=12000`

## Testing

```bash
npm test
```
