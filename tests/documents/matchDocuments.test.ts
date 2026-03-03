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
})
