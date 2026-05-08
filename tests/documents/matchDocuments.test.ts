import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.matchDocuments', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should find documents by filters', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [{ id: '1' }] })

    const result = await db.matchDocuments({ projectIds: ['p1'] })

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      JSON.stringify({ projectIds: ['p1'] }),
      20,
    ])
    expect(result).toEqual([{ id: '1' }])
  })

  it('should work with no filters', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchDocuments({})
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [null, 20])
  })

  it('should accept undefined options and treat them as no filter', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchDocuments(undefined as any)
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [null, 20])
  })

  it('should pass every filter dimension into the SQL params', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchDocuments({
      types: ['t1'],
      ids: ['i1'],
      projectIds: ['p1'],
      limit: 5,
    })

    const filterArg = mockDbClient.query.mock.calls.at(-1)[1][0]
    expect(JSON.parse(filterArg)).toEqual({
      types: ['t1'],
      ids: ['i1'],
      projectIds: ['p1'],
    })
  })

  it('should drop empty filter arrays from the query payload', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    await db.matchDocuments({ types: [], ids: [], projectIds: ['p1'] })

    const filterArg = mockDbClient.query.mock.calls.at(-1)[1][0]
    expect(JSON.parse(filterArg)).toEqual({ projectIds: ['p1'] })
  })
})
