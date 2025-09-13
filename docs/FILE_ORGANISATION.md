# File and Tooling Organisation

Overview

- thefactory-db is a PostgreSQL wrapper that provides FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across files and documents.
- It is designed to be reusable across projects. You can depend on it as a local file dependency ("thefactory-db": "file:../thefactory-db") or publish it to a private registry.
- Database connection is provided via a Postgres connection string so multiple projects can access the same DB (ensure access strategy avoids concurrency hazards at the application layer).

Top-level Layout

- README.md: Quick-start usage and populate script instructions.
- package.json, tsconfig.json: Build and TypeScript configuration.
- src/: Source code for the database wrapper and types.
- docs/: Human-facing documentation for this package (this file).
  - docs/sql/: SQL files for schema, DML and search queries (PostgreSQL flavor).

Key Source Modules (src/)

- src/index.ts: Public entry point. Exports openDatabase(options) which returns a Database API instance. The instance provides:
  - Documents API (text content)
    - addDocument({ type, content?, metadata? }): Promise<Document> — Inserts a document with embedding using the documents table.
    - getDocumentById(id: string): Promise<Document | undefined>
    - updateDocument(id: string, patch: Partial<DocumentInput>): Promise<Document | undefined>
    - deleteDocument(id: string): Promise<boolean>
    - searchDocuments({ query, textWeight?, limit?, ids?, types? }): Promise<DocumentWithScore[]> — Hybrid search over documents via search_documents_query.
  - Entities API (json content)
    - addEntity({ type, content, metadata? }): Promise<Entity> — Inserts an entity with embedding.
    - getEntityById(id: string): Promise<Entity | undefined>
    - updateEntity(id: string, patch: Partial<EntityInput>): Promise<Entity | undefined>
    - deleteEntity(id: string): Promise<boolean>
    - searchEntities({ query, textWeight?, limit?, ids?, types? }): Promise<EntityWithScore[]> — Hybrid search over entities via search_entities_query.
  - raw(): pg.Client — Gives low-level access for advanced SQL.

- src/types.ts: Shared TypeScript types for Documents and Entities, Search options and result row types, and OpenDbOptions.
- src/connection.ts: Connection factory and schema init. Loads SQL from docs/sql/schema.pg.sql and installs hybrid_search functions. Ensures pgvector extension is available. It uses the provided connection string to establish a connection to the database.

Database Schema

- Two tables: documents (text content) and entities (jsonb content)
  - documents fields:
    - id (uuid primary key)
    - type (text)
    - content (text)
    - fts (tsvector generated from content)
    - embedding (vector(384))
    - created_at, updated_at (timestamptz)
    - metadata (jsonb)
  - entities fields:
    - id (uuid primary key)
    - type (text)
    - content (jsonb not null)
    - fts (tsvector generated/triggered from JSON values only)
    - embedding (vector(384))
    - created_at, updated_at (timestamptz)
    - metadata (jsonb)

Hybrid Search

- searchDocuments and searchEntities merge text rank (ts_rank_cd over tsvector using websearch_to_tsquery) and vector cosine similarity using a weight factor (textWeight in [0,1]). Filters (ids/types) are passed via a jsonb argument.
- SQL wrappers are defined as:
  - docs/sql/search_documents_query.pg.sql -> calls hybrid_search_documents
  - docs/sql/search_entities_query.pg.sql -> calls hybrid_search_entities

Scripts (scripts/)

- scripts/populate.ts: CLI tool to scan a project and ingest src/ and docs/ into the DB, then run a sample hybrid search. Currently uses Entities API for ingestion.
  - Flags:
    - --root <path> (default: cwd) Project root to scan
    - --url <postgres-url> (default: DATABASE_URL or localhost)
    - --textWeight <0..1> (default: 0.6) Weight for text vs vector
    - --reset (boolean) TRUNCATE entities/documents

Notes

- Required extensions: pgcrypto and pgvector are created in schema.pg.sql.
- Vector dimension has been updated to 384.
