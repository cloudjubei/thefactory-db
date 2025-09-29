# File and Tooling Organisation

## Overview

- `thefactory-db` is a PostgreSQL wrapper that provides FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across two content models: Documents (text) and Entities (JSON).
- It is designed to be reusable across projects. You can depend on it as a local file dependency ("thefactory-db": "file:../thefactory-db") or publish it to a private registry.
- Database connection is provided via a Postgres connection string so multiple projects can access the same DB (ensure access strategy avoids concurrency hazards at the application layer).
- For details on coding standards and architecture, please see [CODE_STANDARD.md](./CODE_STANDARD.md).

## Top-level Layout

- `README.md`: Quick-start usage and utility scripts.
- `package.json`, `tsconfig.json`: Build and TypeScript configuration.
- `src/`: Source code for the database wrapper and types.
  - `src/index.ts`: Public entry point. Exports `openDatabase(options)` which returns a `Database` API instance. The instance provides:
    - Documents API (text content)
      - `addDocument`, `getDocumentById`, `getDocumentBySrc`, `updateDocument`, `deleteDocument`
      - `searchDocuments`, `matchDocuments`, `clearDocuments`
    - Entities API (json content)
      - `addEntity`, `getEntityById`, `updateEntity`, `deleteEntity`
      - `searchEntities`, `matchEntities`, `clearEntities`
    - `raw(): DB` — Gives low-level access for advanced SQL.
  - `src/connection.ts`: Connection factory and schema init. Applies embedded SQL statements (schema + hybrid functions) defined in `src/utils.ts`.
  - `src/types.ts`: Shared TypeScript types for Documents and Entities, Search options and result row types, and `OpenDbOptions`.
  - `src/logger.ts`: Small logger abstraction with log level filtering.
  - `src/validation.ts`: Runtime input validation for public API methods. Ensures inbound parameters conform to expected shapes and types (documents, entities, search and match params). Tests verify malformed inputs are rejected.
  - `src/utils.ts`: Embedded SQL strings and small helpers (e.g., base64 decoding).
  - `src/utils/embeddings.ts`: Local embedding provider wrapper around Transformers.js.
  - `src/utils/json.ts`: JSON value stringifier used for entity embeddings/FTS.
  - `src/utils/tokenizer.ts`: Tokenizer helpers and FTS normalization utilities.
  - `src/utils/hash.ts`: Hashing utility for content checks.
- `docs/`: Human-facing documentation for this package (this file).
  - `docs/CODE_STANDARD.md`: Coding standards, architectural patterns, and best practices.
  - `docs/sql/`: Reference SQL scripts (schema and hybrid search) for humans. Runtime uses embedded SQL in `src/utils.ts`.
  - `docs/hybrid_search.sql`: Reference hybrid search functions and examples.
  - `docs/TESTING_E2E.md`: How to run E2E tests against a real DB.

## Database Schema

Two tables are maintained:

- `documents` (text content)
  - `id` (uuid primary key, default `gen_random_uuid()`)
  - `project_id` (text not null)
  - `type` (text not null)
  - `name` (text not null) — human-friendly title used for keyword ranking
  - `content` (text)
  - `content_hash` (text) — SHA1 hash of content, used to avoid re-embedding unchanged documents.
  - `fts` (tsvector, generated from `content`)
  - `embedding` (vector(384))
  - `src` (text not null)
  - `created_at`, `updated_at` (timestamptz, `updated_at` maintained via trigger)
  - `metadata` (jsonb)

- `entities` (jsonb content)
  - `id` (uuid primary key, default `gen_random_uuid()`)
  - `project_id` (text not null)
  - `type` (text not null)
  - `content` (jsonb not null)
  - `content_string` (text not null) — tokenized/flattened values used for FTS and embeddings
  - `fts` (tsvector, generated from `content_string`)
  - `embedding` (vector(384))
  - `created_at`, `updated_at` (timestamptz, `updated_at` maintained via trigger)
  - `metadata` (jsonb)

Embedding dimension is 384 and requires the `pgvector` extension.

## Hybrid Search

- `searchDocuments` and `searchEntities` combine text rank (`ts_rank_cd` over `tsvector` using `websearch_to_tsquery`) and vector similarity (cosine similarity) with a weight factor (`textWeight` in [0,1]). Filters (`ids`/`types`/`projectIds`) are passed through as JSON parameters.
- Documents keyword ranking considers token matches in content, the document name, and the `src` basename with higher weight given to name/src.
- Reference SQL shapes are available under `docs/sql/` and `docs/hybrid_search.sql`. The actual SQL executed is embedded in `src/utils.ts`.

## Scripts (`scripts/`)

- `scripts/clear.ts`: CLI tool to truncate or delete by project id.
  - Flags:
    - `--url <postgres-url>` (required) connection string
    - `--p <projectId>` (optional) delete only matching project id
- `scripts/count.ts`: Counts selected documents via the public API.

## Notes

- Required extensions: `pgcrypto` and `pgvector` are created by the schema.
- Vector dimension is 384.

## Testing and Validation

- Unit tests live under `tests/` and target near-100% coverage. They mock external dependencies (e.g., embeddings, PG client) for determinism and speed.
- End-to-End tests live under `tests/e2e/` and run against a real PostgreSQL database with `pgvector`.
- Public API parameters are validated at runtime by `src/validation.ts`. Malformed inputs are rejected with descriptive errors. Tests in `tests/validation.test.ts` and `tests/index-validation.test.ts` verify this behavior.
