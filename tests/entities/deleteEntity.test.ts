import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.deleteEntity', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should return true if deleted', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rowCount: 1 })

    const result = await db.deleteEntity('123')

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123'])
    expect(result).toBe(true)
  })

  it('should return false if not deleted', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rowCount: 0 })

    const result = await db.deleteEntity('123')

    expect(result).toBe(false)
  })
})
