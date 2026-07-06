import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.matchEntities', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should find entities by criteria (and include optional filter + limit)', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

    const result = await db.matchEntities({ projectIds: ['p1'] })

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      JSON.stringify({ projectIds: ['p1'] }),
      null,
      20,
    ])
    expect(result).toEqual([{ id: '1' }])
  })

  it('should work with empty criteria (null criteria param)', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchEntities({})
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [null, null, 20])
  })

  it('should pass filter json when options include projectIds (criteria-empty drops to null)', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchEntities({}, { projectIds: ['p1'], limit: 10 })
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      null,
      JSON.stringify({ projectIds: ['p1'] }),
      10,
    ])
  })

  it('builds a combined filter when types, ids, and projectIds are all present', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchEntities({ tag: 'x' }, { types: ['t1'], ids: ['e1'], projectIds: ['p1'] })

    const call = mockDbClient.query.mock.calls.at(-1)
    const filterParam = JSON.parse(call[1][1])
    expect(filterParam).toEqual({ types: ['t1'], ids: ['e1'], projectIds: ['p1'] })
  })

  it('drops empty arrays from the filter without sending the keys', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchEntities({}, { types: [], ids: [], projectIds: ['p1'] })

    const call = mockDbClient.query.mock.calls.at(-1)
    const filterParam = JSON.parse(call[1][1])
    expect(filterParam).toEqual({ projectIds: ['p1'] })
  })

  describe('null-criteria pass-through (skip jsonb containment when no criteria)', () => {
    // Why: the SQL applies `content @> $1::jsonb` per row. When the caller
    // supplies no criteria, passing `'{}'` makes the predicate true for every
    // row but still forces a per-row jsonb evaluation. Pushing `null` to $1
    // lets the SQL layer skip the check entirely — the difference between a
    // full sort-on-millions and an index scan for large projects.

    it('passes null for $1 when criteria is undefined', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities(undefined, { projectIds: ['p1'] })

      const call = mockDbClient.query.mock.calls.at(-1)
      expect(call[1][0]).toBeNull()
    })

    it('passes null for $1 when criteria is null', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities(null, { projectIds: ['p1'] })

      const call = mockDbClient.query.mock.calls.at(-1)
      expect(call[1][0]).toBeNull()
    })

    it('passes null for $1 when criteria is the empty object', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities({}, { projectIds: ['p1'] })

      const call = mockDbClient.query.mock.calls.at(-1)
      expect(call[1][0]).toBeNull()
    })

    it('still stringifies a real criteria object', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities({ tag: 'x' }, { projectIds: ['p1'] })

      const call = mockDbClient.query.mock.calls.at(-1)
      expect(call[1][0]).toBe(JSON.stringify({ tag: 'x' }))
    })
  })

  describe('dynamic filter/sort/offset path', () => {
    it('routes to the compiled query when a `where` predicate is given', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

      const result = await db.matchEntities(undefined, {
        projectIds: ['p1'],
        where: { field: 'metrics.total_return_pct', op: '>', value: 0 },
        limit: 50,
      })

      const [sql, params] = mockDbClient.query.mock.calls.at(-1)
      // Real compiled SQL (not the mocked 'FAKE_SQL') with the numeric predicate.
      expect(sql).toContain('FROM entities')
      expect(sql).toContain('(content #>> $2::text[])::numeric > $3::numeric')
      expect(params).toEqual([['p1'], ['metrics', 'total_return_pct'], 0, 50])
      expect(result).toEqual([{ id: '1' }])
    })

    it('routes to the compiled query when `orderBy` is given', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities(undefined, {
        orderBy: [{ field: 'objective', direction: 'desc', numeric: true }],
        limit: 25,
      })
      const [sql] = mockDbClient.query.mock.calls.at(-1)
      expect(sql).toMatch(/ORDER BY .*DESC NULLS LAST, updated_at DESC, id ASC/)
    })

    it('routes to the compiled query when `offset` is given (pagination)', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities(undefined, { projectIds: ['p1'], limit: 50, offset: 100 })
      const [sql, params] = mockDbClient.query.mock.calls.at(-1)
      expect(sql).toMatch(/LIMIT \$2 OFFSET \$3/)
      expect(params).toEqual([['p1'], 50, 100])
    })

    it('routes to the compiled query (with the #- projection) when only `omit` is given', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities(undefined, { types: ['run'], omit: ['series'], limit: 5 })
      const [sql, params] = mockDbClient.query.mock.calls.at(-1)
      // Without omit forcing the dynamic path this would fall to the static FAKE_SQL that selects
      // full content — the exact OOM: heavy jsonb read off the socket then dropped in JS.
      expect(sql).not.toBe('FAKE_SQL')
      expect(sql).toContain('#- $1::text[]')
      expect(params[0]).toEqual(['series'])
    })

    it('stays on the static path (FAKE_SQL) when no dynamic params are present', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })

      await db.matchEntities(undefined, { projectIds: ['p1'], limit: 5 })
      const [sql] = mockDbClient.query.mock.calls.at(-1)
      expect(sql).toBe('FAKE_SQL')
    })
  })

  describe('countEntities', () => {
    it('runs a COUNT over the same conditions and returns the number', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [{ count: 42 }] })

      const total = await db.countEntities(undefined, {
        projectIds: ['p1'],
        where: { field: 'objective', op: '>', value: 0 },
      })
      const [sql, params] = mockDbClient.query.mock.calls.at(-1)
      expect(sql).toMatch(/SELECT count\(\*\)::int AS count FROM entities/i)
      expect(sql).not.toMatch(/LIMIT|OFFSET/)
      expect(params).toEqual([['p1'], ['objective'], 0])
      expect(total).toBe(42)
    })

    it('returns 0 when the result set is empty', async () => {
      const db = await openDatabase({ connectionString: 'test' })
      mockDbClient.query.mockResolvedValue({ rows: [] })
      expect(await db.countEntities(undefined, { projectIds: ['p1'] })).toBe(0)
    })
  })
})
