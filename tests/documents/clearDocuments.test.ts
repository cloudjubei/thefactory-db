import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.clearDocuments', () => {
  const { mockDbClient, mockLogger } = setupUnitTestMocks()

  it('should clear documents by project', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearDocuments(['p1'])
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [['p1']])
  })

  // Migrations legitimately log at info during openDatabase, so this is scoped to the message.
  it('logs its entry line at debug, not info', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearDocuments(['p1'])

    expect(mockLogger.debug).toHaveBeenCalledWith('clearDocuments', { count: 1 })
    expect(mockLogger.info.mock.calls.filter((c: any[]) => c[0] === 'clearDocuments')).toEqual([])
  })

  it('should clear all documents', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearDocuments()
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL')
  })
})
