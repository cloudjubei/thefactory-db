import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.clearDocuments', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should clear documents by project', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearDocuments(['p1'])
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1']])
  })

  it('should clear all documents', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearDocuments()
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL')
  })
})
