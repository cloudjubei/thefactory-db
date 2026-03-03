import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.getDocumentById', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('should return a document if found', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const expectedDoc = { id: '123', projectId: 'p1', type: 't1', name: 'Title', content: 'Hi' }
    mockDbClient.query.mockResolvedValue({ rows: [expectedDoc] })

    const result = await db.getDocumentById('123')

    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', ['123'])
    expect(result).toEqual(expectedDoc)
  })

  it('should return undefined if not found', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    const result = await db.getDocumentById('123')

    expect(result).toBeUndefined()
  })
})
