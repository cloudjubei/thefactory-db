import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.getEntityById', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should return an entity if found', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const expected = { id: '123', projectId: 'p1', type: 't1', name: 'Name', content: { a: 1 } }
    mockDbClient.query.mockResolvedValue({ rows: [expected] })

    const result = await db.getEntityById('123')

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123'])
    expect(result).toEqual(expected)
  })

  it('should return undefined if not found', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    const result = await db.getEntityById('123')

    expect(result).toBeUndefined()
  })
})
