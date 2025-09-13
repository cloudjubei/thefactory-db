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
  - addEntity({ type, content?, metadata? }): Promise<Entity> — Inserts an entity with embedding.
  - searchEntities({ query, textWeight?, limit?, types? }): Promise<EntityWithScore[]> — Hybrid search combining ts_rank and vector cosine similarity.
  - raw(): pg.Pool — Gives low-level access for advanced SQL.
- src/types.ts: Shared TypeScript types:
  - EntityType = 'project_file' | 'internal_document' | 'external_blob'
  - Entity shape for insertion and retrieval
  - Search options and result row types
  - OpenDbOptions: requires an external connection string to connect to a PostgreSQL instance.
- src/connection.ts: Connection factory and schema init. Loads SQL from docs/sql/schema.pg.sql and ensures the pgvector extension is available. It uses the provided connection string to establish a connection to the database.

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

- searchEntities merges text rank (ts_rank_cd over tsvector using websearch_to_tsquery) and vector cosine similarity using a weight factor (textWeight in [0,1]).
- The SQL for hybrid search is defined in docs/sql/search_entities.pg.sql and composed dynamically with optional id/type filters.

Scripts (scripts/)

- scripts/populate.ts: CLI tool to scan a project and ingest src/ and docs/ into the DB, then run a sample hybrid search.
  - Flags:
    - --root <path> (default: cwd) Project root to scan
    - --url <postgres-url> (default: DATABASE_URL or localhost)
    - --textWeight <0..1> (default: 0.6) Weight for text vs vector
    - --reset (boolean) TRUNCATE entities/documents

Notes

- Required extensions: pgcrypto and pgvector are created in schema.pg.sql.
- Vector dimension has been updated to 384.
