# File and Tooling Organisation

## Overview

- `thefactory-db` is a PostgreSQL wrapper that provides FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across two content models: Documents (text) and Entities (JSON).
- It is designed to be reusable across projects. You can depend on it as a local file dependency ('thefactory-db': 'file:../thefactory-db') or publish it to a private registry.
- Database connection is provided via a Postgres connection string so multiple projects can access the same DB (ensure access strategy avoids concurrency hazards at the application layer).
- For details on coding standards and architecture, please see [CODE_STANDARD.md](./CODE_STANDARD.md).

## Top-level Layout

- `README.md`: Quick-start usage and utility scripts.
- `package.json`, `tsconfig.json`: Build and TypeScript configuration.
- `eslint.config.js`, `.prettierrc.json`: Lint and formatting rules (`npm run lint`, `npm run format:check`).
- `src/`: Source code for the database wrapper and types.
  - `src/index.ts`: Public entry point. Exports `openDatabase(options)` which returns a `Database` API instance. Also re-exports runtime lifecycle helpers: `createDatabase`, `destroyDatabase`, and `createReusableDatabase`.
    - Documents API (text content)
      - `addDocument`, `getDocumentById`, `getDocumentBySrc`, `updateDocument`, `deleteDocument`, `listDocumentSrcs`, `deleteDocumentsBySrc`
      - `upsertDocuments(inputs, options?)`, `upsertDocument(input)` — write only documents whose content (or chunk version) changed, each in its own savepoint; `options.includeOutdatedChunks: false` leaves re-chunking for an older `CHUNKER_VERSION` to a later pass.
      - `findStaleDocumentSrcs(projectId, sources, options?)` — of `{ src, fingerprint }` pairs, the srcs not stored or stored under another fingerprint (or, unless `includeOutdatedChunks: false`, chunked by an older version): the only sources a re-sync needs to read.
      - `searchDocuments`, `matchDocuments`, `clearDocuments`, `searchDocumentsForPaths`, `searchDocumentsForKeywords`, `searchDocumentsForExact`
    - Entities API (json content)
      - `addEntity`, `upsertEntity`, `getEntityById`, `getEntityByExternalKey`, `updateEntity`, `deleteEntity`
      - `searchEntities`, `matchEntities`, `countEntities`, `clearEntities`
      - `upsertEntity` inserts, or — when `externalKey` is set — updates in place the row uniquely identified by `(projectId, type, externalKey)`. Keyless input always inserts (NULL keys are distinct).
      - `getEntityByExternalKey(projectId, type, externalKey)` — indexed lookup of the single keyed row via the `(project_id, type, external_key)` unique index; returns `undefined` when absent.
      - `matchEntities(criteria, options?)` — beyond the `ids`/`types`/`projectIds`/`limit` filters and the optional `criteria` jsonb-containment, `options` (a `MatchParams`) also accepts a composable content-field filter, content-field ordering, offset pagination, and a content-field `omit`:
        - `where`: an `EntityFilter` — a leaf `{ field, op, value? }` predicate (dot-path `field` into `content`; `op` ∈ `< <= = != >= > contains exists`) or an `and`/`or`/`not` composition of them. Numeric operators (and `=`/`!=` with a numeric `value`) match only rows whose field is a JSON number; a missing/non-numeric field never matches. Both the JSON path and the value are bound parameters — never interpolated.
        - `orderBy`: an `EntitySort[]` — order by content-field dot-paths (`numeric` to cast to numeric, non-numbers sort last); a stable `updated_at`/`id` tiebreak is always appended so pagination never drops or repeats a row.
        - `offset` (+ `limit`): stable, sorted pagination.
        - `omit`: content dot-paths to DROP from each returned row, compiled into the SELECT as a jsonb `#-` chain (guarded so only object nodes are descended, matching the JS `omitPaths`) — so a list view sheds heavy per-row subtrees (`series`, `artifacts.runChart`, …) IN SQL, never reading them off the socket. Each path is a bound `text[]` param. `omit` also forces the advanced (dynamic-SQL) path.
        - The plain identity-tuple path keeps the static query (and its null-criteria index optimisation); the advanced path compiles parameterised SQL via `src/client/entityQuery.ts`.
      - `countEntities(criteria, options?)` — total rows matching the same `where`/`types`/`projectIds`/`criteria` filter as `matchEntities`, ignoring `limit`/`offset`. Pairs with `matchEntities` to report a total for pagination.
    - `raw(): DB` — Gives low-level access for advanced SQL.
  - `src/connection.ts`: Connection factory and schema init. Applies embedded SQL statements (schema + hybrid functions) defined in `src/utils.ts`.
  - `src/types.ts`: Shared TypeScript types for Documents and Entities, Search options and result row types, and `OpenDbOptions`.
  - `src/logger.ts`: Small logger abstraction with log level filtering.
  - `src/validation.ts`: Runtime input validation for public API methods. Ensures inbound parameters conform to expected shapes and types (documents, entities, search and match params). Tests verify malformed inputs are rejected.
  - `src/utils.ts`: Embedded SQL strings and small helpers (e.g., base64 decoding).
  - `src/utils/embeddings.ts`: Local embedding provider wrapper around Transformers.js. `createLocalEmbeddingProvider` (the default) runs the model in a worker thread started from this same module on first use, so inference never blocks the caller's event loop: `createWorkerEmbeddingProvider` is the caller's side (request ids, ref/unref, crash recovery, a graceful `close` that terminates only after `EMBEDDING_WORKER_CLOSE_GRACE_MS`) and `runEmbeddingWorker` the worker's loop. `createInProcessEmbeddingProvider` runs the model on the calling thread.
  - `src/utils/json.ts`: JSON value stringifier used for entity embeddings/FTS.
  - `src/chunking/`: cuts a document into the pieces that get embedded. Every chunk's text starts with a header line naming the path and the enclosing scope or heading path. `CHUNKER_VERSION` is bumped whenever chunking changes.
    - `chunkDocument.ts`: `chunkDocument(src, content)` — picks the chunker by extension, numbers chunk lines, and yields one empty chunk for a file with no text so its path stays findable.
    - `codeChunker.ts`: code with a tree-sitter grammar (TS/TSX/JS/Python, wasm grammars from the `tree-sitter-*` packages), chunked along syntax (cAST: siblings packed up to `CHUNK_MAX_CHARS`, oversized nodes entered, a declaration's opening kept with its first member, an oversized leaf cut into line windows).
    - `markdownChunker.ts`: markdown by headings, then paragraphs, then windows; fenced blocks never start a section.
    - `textChunker.ts`: any other text, by overlapping line-aligned windows.
    - `dataSummary.ts`: bulk data files (`DATA_FILE_EXTS`, large or mostly digits) become one structure summary — JSON key paths with types, a CSV/TSV header and row count, and a sample record.
    - `spans.ts`: span helpers the chunkers share (`trimSpan`, `windowSpans`, `packSpans`).
    - `chunkingConstants.ts`, `chunkingTypes.ts`: limits, grammars and extension sets; chunk and span types.
  - `src/client/documentChunks.ts`: `createChunkWriter` — chunks documents, embeds each chunk (reusing the stored vector of any chunk hash this model already embedded), and replaces a document's chunk rows inside the caller's transaction.
  - `src/client/documents.ts`: the Documents API; batch writes run in one transaction on a dedicated connection, one savepoint per document.
  - `src/utils/tokenizer.ts`: Tokenizer helpers and FTS normalization utilities.
  - `src/utils/hash.ts`: Hashing utility for content checks.
  - `src/migrations/`: Version-keyed schema migrations, applied on connect. `index.ts` is the ordered registry; the runtime path is these migrations (not `SQL.schema`/`SQL.hybridSearch`, which are reference copies). Migration `005` makes the hybrid-search per-lane candidate ceiling a parameter and installs both functions from the single definitions in `src/sql.ts` (`HYBRID_SEARCH_DOCUMENTS_FUNCTION` / `HYBRID_SEARCH_ENTITIES_FUNCTION`) so a migration copy can never drift from the runtime one — the failure `004` exists to repair.
  - `src/runtime.ts`: Runtime database lifecycle helpers for on-demand Postgres with pgvector.
    - `createDatabase(options?: { connectionString?: string; logLevel?: LogLevel })`: Provision an on-demand PostgreSQL with pgvector.
      - Managed mode (default): starts a fresh `pgvector/pgvector:pg16` container via Testcontainers, waits for readiness (port + `SELECT 1`), initializes schema via `openDatabase()`, and returns a client plus a `destroy()` function to tear it down.
      - External mode: given a server `connectionString`, creates a temporary database `tfdb_<random>`, initializes schema, and returns a client plus `destroy()` which drops the temporary database.
    - `destroyDatabase(handle)`: Idempotent teardown for either mode. Managed stops and removes the container; external drops the temp DB from the admin database.
    - `createReusableDatabase(options?: { logLevel?: LogLevel }): Promise<{ connectionString: string; created: boolean }>`: Creates or reuses a long-lived Docker container named `thefactory-db` using image `pgvector/pgvector:pg16` and deterministic credentials. Prefers host port 5435, falling back to a free port, and returns the actual connection string. Initializes schema on first creation and never drops data. Intended for reuse across runs.
    - Process signals SIGINT/SIGTERM are trapped to auto-cleanup managed containers started in this process.
- `docs/`: Human-facing documentation for this package (this file).
  - `docs/CODE_STANDARD.md`: Coding standards, architectural patterns, and best practices.
  - `docs/sql/`: Reference SQL scripts (schema and hybrid search) for humans. Runtime uses embedded SQL in `src/utils.ts`.
  - `docs/hybrid_search.sql`: Reference hybrid search functions and examples.
  - `docs/TESTING_E2E.md`: How to run E2E tests against a real DB.

## Database Schema

Three tables are maintained:

- `documents` (text content)
  - `id` (uuid primary key, default `gen_random_uuid()`)
  - `project_id` (text not null)
  - `type` (text not null)
  - `name` (text not null) — human-friendly title used for keyword ranking
  - `content` (text)
  - `content_hash` (text) — SHA1 hash of content, used to avoid re-embedding unchanged documents. `upsertDocuments` hashes in Node and sends only hashes for change detection.
  - `non_indexable_reason` (text, nullable) — set when Postgres cannot index the document (`too-large`: its lexemes exceed the 1 MB tsvector limit). Such a row is stored with empty `content`, no embedding and no chunks, so it is findable by name and path only; `content_hash` stays the hash of the content it was given, so an unchanged document is not retried. `upsertDocuments` writes each document in its own savepoint: a non-indexable one is stored this way and logged at warn, and one that fails for any other reason is skipped and logged without failing its batch.
  - `fingerprint` (text, nullable) — a cheap, caller-defined identity of the source (thefactory-tools uses a file's size and mtime). `findStaleDocumentSrcs` returns the sources missing or stored under another fingerprint, so a re-sync reads only those; `upsertDocuments` refreshes the fingerprint of a document whose content did not change, without rewriting it.
  - `chunk_version` (integer, nullable) — the `CHUNKER_VERSION` the document's chunks were cut with; a document chunked by another version counts as changed and stale, so a version bump re-chunks everything on the next sync.
  - `fts` (tsvector, generated from `name` and `content`)
  - `embedding` (vector(384)) — no longer written for documents; semantic search uses `document_chunks`.
  - `src` (text not null)
  - `created_at`, `updated_at` (timestamptz, `updated_at` maintained via trigger)
  - `metadata` (jsonb)

- `document_chunks` (one row per embedded piece of a document)
  - `document_id` (uuid, references `documents` on delete cascade), `project_id`, `ord`, `kind` (`code` | `markdown` | `text` | `summary`)
  - `start_line`, `end_line` (1-based), `start_char`, `end_char` (JS string offsets into the document's content)
  - `content_hash` — SHA-1 of the embedding model's name and the chunk text, the key under which an identical chunk's vector is reused
  - `embedding` (vector(384)). No ANN index: the semantic lane ranks the filtered projects' chunks exactly.

- `entities` (jsonb content)
  - `id` (uuid primary key, default `gen_random_uuid()`)
  - `project_id` (text not null)
  - `type` (text not null)
  - `content` (jsonb not null)
  - `should_embed` (boolean not null, default true) — when false, the row is stored without an embedding (skips the vector index; used for high-volume data with no semantic value)
  - `external_key` (text, nullable) — optional dedup key. Unique within `(project_id, type, external_key)`; NULL keys are distinct, so keyless rows duplicate freely while keyed rows upsert in place (see `upsertEntity`)
  - `content_string` (text not null) — tokenized/flattened values used for FTS and embeddings
  - `fts` (tsvector, generated from `content_string`)
  - `embedding` (vector(384))
  - `created_at`, `updated_at` (timestamptz, `updated_at` maintained via trigger)
  - `metadata` (jsonb)
  - Unique index `(project_id, type, external_key)` is the ON CONFLICT arbiter for `upsertEntity`.

Embedding dimension is 384 and requires the `pgvector` extension.

## Hybrid Search

- Documents' semantic lane ranks each document by its best chunk (MaxP) and returns that chunk's span (`startLine`/`endLine`, `startChar`/`endChar`) as `matchedChunk`; a name match the hybrid search also found carries the same.
- `searchDocuments` and `searchEntities` combine text rank (`ts_rank_cd` over `tsvector` using `websearch_to_tsquery`) and vector similarity (cosine similarity) with a weight factor (`textWeight` in [0,1]). Filters (`ids`/`types`/`projectIds`) are passed through as JSON parameters.
- `candidateLimit` (default `HYBRID_CANDIDATE_LIMIT_DEFAULT` = 100, clamped to `[1, HYBRID_CANDIDATE_LIMIT_MAX]` = 1000) bounds how many rows EACH ranked lane (full-text, semantic) contributes before the reciprocal-rank join. It was previously hardcoded at 60 while the literal-substring lane stayed uncapped, so past 60 rows per signal the ordering came from raw substring count alone. The clamp is applied both in TypeScript (`resolveCandidateLimit`) and inside the SQL, so a `raw()` caller is bounded identically. Raise it for large collections at the cost of more work per query.
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
