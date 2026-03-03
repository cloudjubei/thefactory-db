import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from './utils/unitTestMocks'
import { openDatabase } from '../src/index'

describe('TheFactoryDb.close', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should end the database connection', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.close()
    expect(mockDbClient.end).toHaveBeenCalled()
  })
})
