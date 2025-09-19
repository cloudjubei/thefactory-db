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
- `docs/`: Human-facing documentation for this package (this file).
  - `docs/CODE_STANDARD.md`: Coding standards, architectural patterns, and best practices.
  - `docs/sql/`: Reference SQL scripts (schema and hybrid search) for humans. Runtime uses embedded SQL in `src/utils.ts`.
  - `docs/hybrid_search.sql`: Reference hybrid search functions and examples.

## Key Source Modules (`src/`)

- `src/index.ts`: Public entry point. Exports `openDatabase(options)` which returns a `Database` API instance. The instance provides:
  - Documents API (text content)
    - `addDocument({ projectId, type, content, src, metadata? }): Promise<Document>` — Inserts a document with embedding using the `documents` table.
    - `getDocumentById(id: string): Promise<Document | undefined>`
    - `getDocumentBySrc(src: string): Promise<Document | undefined>`
    - `updateDocument(id: string, patch: Partial<DocumentInput>): Promise<Document | undefined>`
    - `deleteDocument(id: string): Promise<boolean>`
    - `searchDocuments({ query, textWeight?, limit?, projectIds?, ids?, types? }): Promise<DocumentWithScore[]>` — Hybrid search over documents via `hybrid_search_documents`.
    - `matchDocuments({ limit?, projectIds?, ids?, types? }): Promise<Document[]>` — Filter-only retrieval helper.
  - Entities API (json content)
    - `addEntity({ projectId, type, content, metadata? }): Promise<Entity>` — Inserts an entity with embedding. For embeddings, JSON values are stringified without keys/braces/colons to reduce noise.
    - `getEntityById(id: string): Promise<Entity | undefined>`
    - `updateEntity(id: string, patch: Partial<EntityInput>): Promise<Entity | undefined>`
    - `deleteEntity(id: string): Promise<boolean>`
    - `searchEntities({ query, textWeight?, limit?, projectIds?, ids?, types? }): Promise<EntityWithScore[]>` — Hybrid search over entities via `hybrid_search_entities`.
    - `matchEntities(criteria, { limit?, projectIds?, ids?, types? }): Promise<Entity[]>` — Returns entities whose JSON content contains the provided JSON structure (Postgres `@>` containment).
  - `raw(): DB` — Gives low-level access for advanced SQL.

- `src/types.ts`: Shared TypeScript types for Documents and Entities, Search options and result row types, and `OpenDbOptions`.
- `src/connection.ts`: Connection factory and schema init. Applies embedded SQL statements (schema + hybrid functions) defined in `src/utils.ts`. Ensures required extensions exist.

## Database Schema

Two tables are maintained:

- `documents` (text content)
  - `id` (uuid primary key, default `gen_random_uuid()`)
  - `project_id` (text not null)
  - `type` (text not null)
  - `content` (text)
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
