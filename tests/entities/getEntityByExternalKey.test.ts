import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.getEntityByExternalKey', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should return the entity matching (projectId, type, externalKey)', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const expected = {
      id: '123',
      projectId: 'p1',
      type: 'holding',
      externalKey: 'AAPL',
      content: { a: 1 },
    }
    mockDbClient.query.mockResolvedValue({ rows: [expected] })

    const result = await db.getEntityByExternalKey('p1', 'holding', 'AAPL')

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['p1', 'holding', 'AAPL'])
    expect(result).toEqual(expected)
  })

  it('should return undefined when no row matches', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    const result = await db.getEntityByExternalKey('p1', 'holding', 'AAPL')

    expect(result).toBeUndefined()
  })
})
