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
  })

  it('hybrid_search_entities RETURNS TABLE declares should_embed so searchEntitiesQuery can project it', () => {
    // `searchEntitiesQuery` selects from `hybrid_search_entities(...)`. If
    // the SQL function's RETURNS TABLE doesn't include `should_embed`,
    // adding the alias to the outer SELECT silently produces NULL. Both
    // ends have to carry it.
    expect(SQL.hybridSearch).toMatch(/RETURNS TABLE\s*\(([^)]*\bshould_embed\s+boolean\b)/i)
  })
})
