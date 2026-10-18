import { describe, it, expect } from 'vitest'

import { DOCUMENT_CONTENT_HASH_FUNCTION, resolveCandidateLimit, SQL } from '../src/sql'

/**
 * Pure-string assertions on the SQL constants. These don't need a DB —
 * they catch the entire class of "we forgot to project a column" bugs that
 * only blow up at runtime when Fastify rejects the response against
 * `EntitySchema`. The shipped `Entity` type carries `shouldEmbed: boolean`
 * (see `src/types.ts`), so every entity-shaped result row must project it.
 *
 * If you add a new entity-shaped query, add it to `ENTITY_PROJECTIONS`
 * below and the audit catches the next omission for free.
 */
const ENTITY_PROJECTIONS: { name: string; sql: string }[] = [
  { name: 'getEntityById', sql: SQL.getEntityById },
  { name: 'getEntityByExternalKey', sql: SQL.getEntityByExternalKey },
  { name: 'insertEntity', sql: SQL.insertEntity },
  { name: 'upsertEntity', sql: SQL.upsertEntity },
  { name: 'updateEntity', sql: SQL.updateEntity },
  { name: 'matchEntities', sql: SQL.matchEntities },
  { name: 'searchEntitiesQuery', sql: SQL.searchEntitiesQuery },
]

describe('SQL projections — entity-shaped queries match the published Entity type', () => {
  it.each(ENTITY_PROJECTIONS)('$name projects every required Entity field', ({ sql }) => {
    // Required fields per `Entity` in src/types.ts. The id alias varies
    // (some queries `id`, some `id::text AS id`), so we only assert the
    // identifier appears as a column reference somewhere in the SELECT.
    expect(sql).toMatch(/\bid\b/)
    expect(sql).toContain('project_id AS "projectId"')
    expect(sql).toContain('type')
    expect(sql).toContain('content')
    expect(sql).toContain('"createdAt"')
    expect(sql).toContain('"updatedAt"')
    expect(sql).toContain('metadata')
    // The bug that motivated this audit: `should_embed` is on the
    // `entities` table but several queries hand-projected columns and
    // dropped it, so Fastify response validation rejected every row.
    expect(sql).toContain('should_embed AS "shouldEmbed"')
    expect(sql).toContain('external_key AS "externalKey"')
  })

  it('hybrid_search_entities RETURNS TABLE declares should_embed so searchEntitiesQuery can project it', () => {
    // `searchEntitiesQuery` selects from `hybrid_search_entities(...)`. If
    // the SQL function's RETURNS TABLE doesn't include `should_embed`,
    // adding the alias to the outer SELECT silently produces NULL. Both
    // ends have to carry it.
    expect(SQL.hybridSearch).toMatch(/RETURNS TABLE\s*\(([^)]*\bshould_embed\s+boolean\b)/i)
  })

  it('hybrid_search_entities RETURNS TABLE declares external_key so searchEntitiesQuery can project it', () => {
    expect(SQL.hybridSearch).toMatch(/RETURNS TABLE\s*\(([^)]*\bexternal_key\s+text\b)/i)
  })

  it('upsertEntity arbitrates on the (project_id, type, external_key) conflict', () => {
    expect(SQL.upsertEntity).toMatch(
      /ON\s+CONFLICT\s*\(\s*project_id\s*,\s*type\s*,\s*external_key\s*\)\s+DO\s+UPDATE/i,
    )
  })

  it('schema creates the (project_id, type, external_key) unique index on entities', () => {
    expect(SQL.schema).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w+\s+ON\s+entities\s*\(\s*project_id\s*,\s*type\s*,\s*external_key\s*\)/i,
    )
  })
})

/**
 * Every document-shaped result row is answered against the published
 * `Document` type, which requires `contentHash`; `matchDocuments` once
 * hand-projected its columns without it and every `GET /documents` failed
 * response validation with a 500.
 */
const DOCUMENT_ROW_PROJECTIONS: { name: string; sql: string }[] = [
  { name: 'getDocumentById', sql: SQL.getDocumentById },
  { name: 'getDocumentBySrc', sql: SQL.getDocumentBySrc },
  { name: 'upsertDocument', sql: SQL.upsertDocument },
  { name: 'insertDocument', sql: SQL.insertDocument },
  { name: 'upsertNonIndexableDocument', sql: SQL.upsertNonIndexableDocument },
  { name: 'updateDocument', sql: SQL.updateDocument },
  { name: 'matchDocuments', sql: SQL.matchDocuments },
  { name: 'searchDocumentsQuery', sql: SQL.searchDocumentsQuery },
  { name: 'searchDocumentsByName', sql: SQL.searchDocumentsByName },
]

describe('SQL projections — document-shaped queries match the published Document type', () => {
  it.each(DOCUMENT_ROW_PROJECTIONS)('$name projects contentHash', ({ sql }) => {
    expect(sql).toMatch(/content_hash\s+AS\s+"contentHash"/i)
  })

  it.each(DOCUMENT_ROW_PROJECTIONS)('$name projects nonIndexableReason', ({ sql }) => {
    expect(sql).toMatch(/non_indexable_reason\s+AS\s+"nonIndexableReason"/i)
  })
})

describe('SQL.searchDocumentsQuery — joined for the content hash', () => {
  it('keeps the order the hybrid search ranked its rows in', () => {
    expect(SQL.searchDocumentsQuery).toMatch(/WITH ORDINALITY AS h/)
    expect(SQL.searchDocumentsQuery).toMatch(/ORDER BY h\.ordinality;/)
  })
})

describe('SQL.matchEntities — null-criteria short-circuit', () => {
  // Why: when the caller has no criteria (the common "list this project's
  // entities" path), the SQL must NOT apply `content @> $1::jsonb`. That
  // predicate is semantically vacuous for `$1 = '{}'` but forces a per-row
  // jsonb evaluation against `content` — kills the index plan on large
  // projects. Guarding the clause with `$1::jsonb IS NULL OR ...` lets the
  // planner skip the per-row work when $1 is passed as NULL.

  it('guards `content @> $1` so it is skipped when $1 IS NULL', () => {
    // Tolerant of whitespace / parenthesisation; the key is that the
    // `content @> $1::jsonb` predicate sits inside an `$1::jsonb IS NULL OR`
    // alternative so it never runs against every row when criteria is null.
    expect(SQL.matchEntities).toMatch(/\$1::jsonb\s+IS\s+NULL\s+OR\s+content\s*@>\s*\$1::jsonb/i)
  })

  it('does NOT apply `content @> $1` unconditionally (no bare `WHERE content @> $1`)', () => {
    // Drift guard: catches the original shape `WHERE content @> $1::jsonb`
    // (no surrounding NULL-or alternative) coming back in a future edit.
    expect(SQL.matchEntities).not.toMatch(/WHERE\s+content\s*@>\s*\$1::jsonb\b\s*AND/i)
  })
})

describe('SQL.schema — entities composite index for project_id + updated_at DESC', () => {
  // Why: `matchEntities` filters by `project_id` and orders by `updated_at
  // DESC` with a small LIMIT. Without a composite index, Postgres has to
  // sort the entire project's rowset before picking the top N. Adding
  // `(project_id, updated_at DESC)` lets the planner walk the index in
  // order and stop at LIMIT — milliseconds even on millions of rows.

  it('schema creates a (project_id, updated_at DESC) index on entities', () => {
    expect(SQL.schema).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+\w*project_id_updated_at\w*\s+ON\s+entities\s*\(\s*project_id\s*,\s*updated_at\s+DESC\s*\)/i,
    )
  })

  it('exposes the per-lane candidate ceiling as a clamped PARAMETER on both functions', () => {
    // Previously both ranked lanes were hardcoded to 60 rows while the literal lane was uncapped, so past
    // 60 rows per signal the ordering came from substring count alone.
    for (const fn of [SQL.hybridSearch]) {
      expect(fn).toMatch(/candidate_limit\s+integer\s+DEFAULT\s+100/i)
      expect(fn).not.toMatch(/match_count,\s*30\)\s*\*\s*2/i)
    }
    // The clamp lives in SQL too, so a raw() caller cannot exceed the ceiling either.
    expect(SQL.hybridSearch).toMatch(
      /LEAST\(GREATEST\(COALESCE\(candidate_limit, 100\), 1\), 1000\)/,
    )
  })

  it('drops the OLD signatures, since CREATE OR REPLACE cannot change an argument list', () => {
    // Without the drop the new parameter would add a second overload and an 8-arg call would become
    // ambiguous rather than resolving.
    expect(SQL.hybridSearch).toMatch(
      /DROP FUNCTION IF EXISTS hybrid_search_entities\(text, vector, integer, jsonb, float, float, float, integer\)/,
    )
    expect(SQL.hybridSearch).toMatch(
      /DROP FUNCTION IF EXISTS hybrid_search_documents\(text, vector, integer, jsonb, float, float, float, float, integer\)/,
    )
  })
})

describe('resolveCandidateLimit', () => {
  it('defaults, floors, and clamps to the ceiling', () => {
    expect(resolveCandidateLimit(undefined)).toBe(100)
    expect(resolveCandidateLimit(250)).toBe(250)
    expect(resolveCandidateLimit(1000)).toBe(1000)
    expect(resolveCandidateLimit(999999)).toBe(1000)
    expect(resolveCandidateLimit(0)).toBe(1)
    expect(resolveCandidateLimit(-5)).toBe(1)
  })
  it('rejects a non-finite value rather than binding NaN into the query', () => {
    expect(resolveCandidateLimit(Number.NaN)).toBe(100)
    expect(resolveCandidateLimit(Number.POSITIVE_INFINITY)).toBe(100)
    expect(resolveCandidateLimit('50' as unknown as number)).toBe(100)
  })
  it('truncates a fractional value to an integer', () => {
    expect(resolveCandidateLimit(120.9)).toBe(120)
  })
})

const DOCUMENT_PROJECTIONS: { name: string; sql: string }[] = [
  { name: 'getDocumentById', sql: SQL.getDocumentById },
  { name: 'getDocumentBySrc', sql: SQL.getDocumentBySrc },
  { name: 'insertDocument', sql: SQL.insertDocument },
  { name: 'upsertDocument', sql: SQL.upsertDocument },
  { name: 'upsertNonIndexableDocument', sql: SQL.upsertNonIndexableDocument },
  { name: 'updateDocument', sql: SQL.updateDocument },
]

describe('SQL — documents that cannot be indexed', () => {
  it.each(DOCUMENT_PROJECTIONS)('$name projects nonIndexableReason', ({ sql }) => {
    expect(sql).toContain('non_indexable_reason AS "nonIndexableReason"')
  })

  it('schema declares the non_indexable_reason column on documents', () => {
    expect(SQL.schema).toMatch(
      /CREATE TABLE IF NOT EXISTS documents \([^;]*\bnon_indexable_reason text,/,
    )
  })

  it('the content-hash trigger keeps the hash a non-indexable row was written with', () => {
    // A flagged row stores no content but the hash of the content it was given, so an unchanged
    // file is recognised and not embedded and rejected again on every ingestion.
    expect(DOCUMENT_CONTENT_HASH_FUNCTION).toMatch(
      /IF NEW\.content IS NOT NULL AND NEW\.non_indexable_reason IS NULL THEN/,
    )
    expect(SQL.schema).toContain(DOCUMENT_CONTENT_HASH_FUNCTION)
  })

  it('upsertNonIndexableDocument stores no content or embedding but the hash of the content given', () => {
    expect(SQL.upsertNonIndexableDocument).toMatch(
      /VALUES \(\$1, \$2, \$3, \$4, '', encode\(digest\(\$5, 'sha1'\), 'hex'\), NULL, \$6::jsonb, \$7, \$8, \$9\)/,
    )
    expect(SQL.upsertNonIndexableDocument).toMatch(
      /content = '',\s*content_hash = EXCLUDED\.content_hash,\s*embedding = NULL,/,
    )
  })

  it('upsertNonIndexableDocument skips a row already flagged for the same content and reason', () => {
    expect(SQL.upsertNonIndexableDocument).toMatch(
      /WHERE documents\.content_hash IS DISTINCT FROM EXCLUDED\.content_hash\s+OR documents\.non_indexable_reason IS DISTINCT FROM EXCLUDED\.non_indexable_reason/,
    )
  })

  it('upsertDocument clears the flag when a document is stored with its content', () => {
    expect(SQL.upsertDocument).toMatch(/non_indexable_reason = NULL,/)
  })

  it('updateDocument clears the flag only when it patches the content', () => {
    expect(SQL.updateDocument).toMatch(
      /non_indexable_reason = CASE WHEN \$5::text IS NULL THEN non_indexable_reason ELSE NULL END/,
    )
  })
})

describe('SQL — change detection and fingerprints', () => {
  it('getChangingDocuments compares stored hashes with hashes it is given, not content', () => {
    expect(SQL.getChangingDocuments).toMatch(/unnest\(\$2::text\[\], \$3::text\[\]\)/)
    expect(SQL.getChangingDocuments).toMatch(/d\.content_hash IS DISTINCT FROM i\.content_hash/)
    expect(SQL.getChangingDocuments).not.toContain('digest(')
  })

  it('findStaleDocumentSrcs returns sources missing or stored under another fingerprint', () => {
    expect(SQL.findStaleDocumentSrcs).toMatch(
      /LEFT JOIN documents d ON d\.project_id = \$1 AND d\.src = i\.src/,
    )
    expect(SQL.findStaleDocumentSrcs).toMatch(
      /WHERE d\.id IS NULL\s+OR d\.fingerprint IS DISTINCT FROM i\.fingerprint/,
    )
  })

  it('refreshDocumentFingerprints only touches rows whose content is unchanged', () => {
    expect(SQL.refreshDocumentFingerprints).toMatch(/d\.content_hash = i\.content_hash/)
    expect(SQL.refreshDocumentFingerprints).toMatch(
      /d\.fingerprint IS DISTINCT FROM i\.fingerprint/,
    )
  })

  it.each([
    ['upsertDocument', SQL.upsertDocument],
    ['upsertNonIndexableDocument', SQL.upsertNonIndexableDocument],
  ])('%s stores the fingerprint it is given', (_name, sql) => {
    expect(sql).toMatch(/fingerprint = EXCLUDED\.fingerprint/)
  })

  it('schema declares the fingerprint column on documents', () => {
    expect(SQL.schema).toMatch(/CREATE TABLE IF NOT EXISTS documents \([^;]*\bfingerprint text,/)
  })
})

describe('SQL — document chunks', () => {
  it('schema declares the chunks table, cascading from its document, and the chunk version', () => {
    expect(SQL.schema).toMatch(
      /CREATE TABLE IF NOT EXISTS document_chunks \([^;]*document_id uuid NOT NULL REFERENCES documents\(id\) ON DELETE CASCADE/,
    )
    expect(SQL.schema).toMatch(
      /CREATE TABLE IF NOT EXISTS documents \([^;]*\bchunk_version integer,/,
    )
    // No ANN index: the semantic lane ranks a filtered set of chunks exactly (see below).
    expect(SQL.schema).not.toMatch(/document_chunks USING hnsw/)
  })

  it('getChangingDocuments treats another chunk version as a change only when given a version', () => {
    expect(SQL.getChangingDocuments).toMatch(
      /OR \(\$4::int IS NOT NULL AND d\.chunk_version IS DISTINCT FROM \$4::int\)/,
    )
  })

  it('findStaleDocumentSrcs counts another chunk version as stale only when given a version', () => {
    expect(SQL.findStaleDocumentSrcs).toMatch(
      /OR \(\$4::int IS NOT NULL AND d\.chunk_version IS DISTINCT FROM \$4::int\)/,
    )
  })

  it.each([
    ['upsertDocument', SQL.upsertDocument],
    ['upsertNonIndexableDocument', SQL.upsertNonIndexableDocument],
  ])(
    '%s rewrites a document chunked by another version even when its content is unchanged',
    (_name, sql) => {
      expect(sql).toMatch(/OR documents\.chunk_version IS DISTINCT FROM EXCLUDED\.chunk_version/)
      expect(sql).toMatch(/chunk_version = EXCLUDED\.chunk_version/)
    },
  )

  it("replaces a document's chunks from parallel arrays, embeddings as vector text", () => {
    expect(SQL.deleteDocumentChunks).toBe('DELETE FROM document_chunks WHERE document_id = $1;')
    expect(SQL.insertDocumentChunks).toMatch(/INSERT INTO document_chunks/)
    expect(SQL.insertDocumentChunks).toMatch(/e::vector/)
  })

  it('looks up stored embeddings by chunk hash, one per hash', () => {
    expect(SQL.findChunkEmbeddings).toMatch(
      /SELECT DISTINCT ON \(content_hash\) content_hash, embedding::text/,
    )
  })

  it('clears documents together with their chunks', () => {
    expect(SQL.clearDocuments).toBe('TRUNCATE TABLE document_chunks, documents RESTART IDENTITY;')
  })

  it("ranks the semantic lane by each document's best chunk and returns that chunk's span", () => {
    const fn = SQL.hybridSearch
    expect(fn).toMatch(/FROM document_chunks c/)
    // Exact: the filtered chunks are materialised first, so no approximate index can drop a small
    // project's chunks from the candidates.
    expect(fn).toMatch(/filtered_chunks AS MATERIALIZED \(/)
    expect(fn).not.toMatch(/hnsw\.iterative_scan/)
    expect(fn).toMatch(/DISTINCT ON \(ch\.document_id\)/)
    expect(fn).toMatch(
      /RETURNS TABLE \([^)]*chunk_start_line integer,\s*chunk_end_line integer,\s*chunk_start_char integer,\s*chunk_end_char integer/,
    )
    expect(fn).not.toMatch(
      /ORDER BY embedding <#> query_embedding\s*\)\s*AS rank_ix\s*FROM base_documents/,
    )
    expect(SQL.searchDocumentsQuery).toContain('chunk_start_line AS "chunkStartLine"')
  })
})
