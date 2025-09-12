# File and Tooling Organisation

Overview
- thefactory-db is a standalone, local-first PostgreSQL package with FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across files and documents.
- It is designed to be reusable across projects. You can depend on it as a local file dependency ("thefactory-db": "file:../thefactory-db") or publish it to a private registry.
- Database connection is provided via a Postgres connection string so multiple projects can access the same DB (ensure access strategy avoids concurrency hazards at the application layer).

Top-level Layout
- README.md: Quick-start usage and populate script instructions.
- package.json, tsconfig.json: Build and TypeScript configuration.
- src/: Source code for the database wrapper and types.
- docs/: Human-facing documentation for this package (this file).
  - docs/sql/: SQL files for schema, DML and search queries (PostgreSQL flavor).
- scripts/: Development/utility scripts (e.g., populate.ts to ingest files and test search).

Key Source Modules (src/)
- src/index.ts: Public entry point. Exports openDatabase(options) which returns a Database API instance. The instance provides:
  - addEntity({ type, content?, metadata? }): Promise<Entity> — Inserts an entity with embedding.
  - searchEntities({ query, textWeight?, limit?, types? }): Promise<EntityWithScore[]> — Hybrid search combining ts_rank and vector cosine similarity.
  - raw(): pg.Pool — Gives low-level access for advanced SQL.
- src/types.ts: Shared TypeScript types:
  - EntityType = 'project_file' | 'internal_document' | 'external_blob'
  - Entity shape for insertion and retrieval
  - Search options and result row types
  - OpenDbOptions: now supports either an external connection string or a local data directory for an embedded Postgres runtime.
- src/connection.ts: Connection factory and schema init. Loads SQL from docs/sql/schema.pg.sql and ensures pgvector extension. Includes ensureEmbeddedPostgres() which boots a local Postgres using pg-embedded given a data directory and returns a connection string. openPostgres() accepts either a connectionString or databaseDir and will start the embedded server when needed.

Database Schema
- entities table fields:
  - id (uuid primary key)
  - type (text: 'project_file' | 'internal_document' | 'external_blob')
  - content (text, optional)
  - fts (tsvector, generated from content)
  - embedding (vector(1536))
  - created_at, updated_at (timestamptz)
  - metadata (jsonb, optional)

Hybrid Search
- searchEntities merges text rank (ts_rank_cd over tsvector using websearch_to_tsquery) and vector cosine similarity using a weight factor (textWeight in [0,1]).
- The SQL for hybrid search is defined in docs/sql/search_entities.pg.sql and composed dynamically with optional type filters.

Scripts (scripts/)
- scripts/populate.ts: CLI tool to scan a project and ingest src/ and docs/ into the DB, then run a sample hybrid search.
  - Flags:
    - --root <path> (default: cwd) Project root to scan
    - --url <postgres-url> (default: DATABASE_URL or localhost)
    - --textWeight <0..1> (default: 0.6) Weight for text vs vector
    - --reset (boolean) TRUNCATE entities

Local PostgreSQL Runtime
- This project includes the pg-embedded dependency to enable running a self-contained PostgreSQL instance without relying on external services.
- SQL files under docs/sql/ continue to be the single source of truth for schema and queries (loaded at runtime by utility functions, e.g., readSql).
- Consumers can configure the database data directory path with OpenDbOptions.databaseDir. If not provided, the implementation uses a default directory ./.thefactory-db/pgdata within the current working directory. Alternatively, provide OpenDbOptions.connectionString to connect to an existing PostgreSQL instance.

Usage in Other Projects
- Add as a local dependency or install from your registry. Provide either a Postgres connection string or rely on the embedded runtime with a default data directory.
- Example:
  - import { openDatabase } from 'thefactory-db'
  - const db = await openDatabase({ databaseDir: ".thefactory-db/pgdata" }) // or omit for default
  - // or: const db = await openDatabase({ connectionString: process.env.DATABASE_URL })
  - await db.addEntity(...); const rows = await db.searchEntities(...);
