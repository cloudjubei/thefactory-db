import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.clearEntities', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should clear entities by project', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearEntities(['p1'])
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1']])
  })

  it('should clear all entities', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearEntities()
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL')
  })
})
