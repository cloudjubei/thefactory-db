import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.clearEntities', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should clear entities by projectIds', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearEntities({ projectIds: ['p1', 'p2'] })
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1', 'p2']])
  })

  it('should clear entities by projectIds and types', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearEntities({ projectIds: ['p1'], types: ['note'] })
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1'], ['note']])
  })

  it('should ignore an empty types array and clear by projectIds only', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearEntities({ projectIds: ['p1'], types: [] })
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1']])
  })

  it('should reject an empty projectIds array', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await expect(db.clearEntities({ projectIds: [] })).rejects.toThrow(/projectIds/)
    expect(mockDbClient.query).not.toHaveBeenCalled()
  })
})
