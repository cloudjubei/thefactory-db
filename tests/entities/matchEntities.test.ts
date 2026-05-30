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
})
