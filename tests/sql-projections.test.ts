import { describe, it, expect } from 'vitest'
import { SQL } from '../src/sql'

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
})
