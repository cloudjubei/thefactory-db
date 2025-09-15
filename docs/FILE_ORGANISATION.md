# File and Tooling Organisation

Overview

- thefactory-db is a PostgreSQL wrapper that provides FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across two content models: Documents (text) and Entities (JSON).
- It is designed to be reusable across projects. You can depend on it as a local file dependency ("thefactory-db": "file:../thefactory-db") or publish it to a private registry.
- Database connection is provided via a Postgres connection string so multiple projects can access the same DB (ensure access strategy avoids concurrency hazards at the application layer).

Top-level Layout

- README.md: Quick-start usage and populate script instructions.
- package.json, tsconfig.json: Build and TypeScript configuration.
- src/: Source code for the database wrapper and types.
- docs/: Human-facing documentation for this package (this file).
  - docs/schema.sql: Canonical Postgres schema and function definitions for Documents and Entities.
  - docs/hybrid_search.sql: Reference hybrid search functions and examples for both tables, including filters by ids/types and JSON match.

Key Source Modules (src/)

- src/index.ts: Public entry point. Exports openDatabase(options) which returns a Database API instance. The instance provides:
  - Documents API (text content)
    - addDocument({ projectId, type, content, metadata? }): Promise<Document> — Inserts a document with embedding using the documents table.
    - getDocumentById(id: string): Promise<Document | undefined>
    - updateDocument(id: string, patch: Partial<DocumentInput>): Promise<Document | undefined>
    - deleteDocument(id: string): Promise<boolean>
    - searchDocuments({ query, textWeight?, limit?, projectIds?, ids?, types? }): Promise<DocumentWithScore[]> — Hybrid search over documents via hybrid_search_documents.
  - Entities API (json content)
    - addEntity({ projectId, type, content, metadata? }): Promise<Entity> — Inserts an entity with embedding. For tokens/embeddings, JSON values are stringified without keys/braces/colons to reduce noise.
    - getEntityById(id: string): Promise<Entity | undefined>
    - updateEntity(id: string, patch: Partial<EntityInput>): Promise<Entity | undefined>
    - deleteEntity(id: string): Promise<boolean>
    - searchEntities({ query, textWeight?, limit?, projectIds?, ids?, types? }): Promise<EntityWithScore[]> — Hybrid search over entities via hybrid_search_entities.
    - matchEntities({ match, limit?, projectIds?, ids?, types? }): Promise<Entity[]> — Returns entities whose JSON content contains the provided JSON structure (Postgres @> containment). Optional ids/types filters are supported.
  - raw(): DB — Gives low-level access for advanced SQL.

- src/types.ts: Shared TypeScript types for Documents and Entities, Search options and result row types, and OpenDbOptions.
- src/connection.ts: Connection factory and schema init. Loads SQL from docs/schema.sql and installs hybrid_search functions. Ensures pgvector extension is available.

Database Schema

Two tables are maintained:

- documents (text content)
  - id (uuid primary key, default gen_random_uuid())
  - type (text not null)
  - content (text not null)
  - fts (tsvector, generated from content)
  - embedding (vector(384))
  - created_at, updated_at (timestamptz, updated_at maintained via trigger)
  - metadata (jsonb)

- entities (jsonb content)
  - id (uuid primary key, default gen_random_uuid())
  - type (text not null)
  - content (jsonb not null)
  - fts (tsvector, generated from JSON values only; keys and punctuation excluded)
  - embedding (vector(384))
  - created_at, updated_at (timestamptz, updated_at maintained via trigger)
  - metadata (jsonb)

Embedding dimension is 384 and requires the pgvector extension.

Hybrid Search

- searchDocuments and searchEntities combine text rank (ts_rank_cd over tsvector using websearch_to_tsquery) and vector similarity (cosine distance) with a weight factor (textWeight in [0,1]). Filters (ids/types) are passed through as parameters.
- SQL reference implementations are provided in docs/hybrid_search.sql with:
  - hybrid_search_documents(query text, query_vec vector, text_weight real, max_results int, ids uuid[] default null, types text[] default null)
  - hybrid_search_entities(query text, query_vec vector, text_weight real, max_results int, ids uuid[] default null, types text[] default null)
- JSON match utility for entities:
  - match_entities(match jsonb, max_results int default 50, ids uuid[] default null, types text[] default null)

Scripts (scripts/)

- scripts/populate.ts: CLI tool to scan a project and ingest into the DB, then run a sample hybrid search.
  - Flags:
    - --root <path> (default: cwd) Project root to scan
    - --url <postgres-url> (default: DATABASE_URL or localhost)
    - --textWeight <0..1> (default: 0.6) Weight for text vs vector
    - --reset (boolean) TRUNCATE entities/documents

Breaking Changes

- The previous single "entities" table that stored text content is now split:
  - The old behavior maps to the new documents table (text content).
  - A new entities table now stores JSON content and supports JSON containment matching via matchEntities.

Notes

- Required extensions: pgcrypto and pgvector are created in docs/schema.sql.
- Vector dimension is 384.
