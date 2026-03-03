import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.updateDocument', () => {
  const { mockDbClient, mockLogger, mockEmbeddingProvider } = setupUnitTestMocks()

  it('should update an existing document (including embedding when content is provided)', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const existingDoc = { id: '123', name: 'Title', content: 'old' }
    const patch = { content: 'new' }
    const updatedDoc = { ...existingDoc, ...patch }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] }) // get by id
      .mockResolvedValueOnce({ rows: [updatedDoc] }) // update

    const result = await db.updateDocument('123', patch)

    expect(mockDbClient.query).toHaveBeenNthCalledWith(1, 'FAKE_SQL', ['123'])
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith('new')
    expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
      '123',
      null,
      null,
      null,
      'new',
      '[0.1,0.2,0.3]',
      null,
    ])
    expect(result).toEqual(updatedDoc)
  })

  it('should return undefined if document does not exist', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    const result = await db.updateDocument('123', { content: 'new' })
    expect(result).toBeUndefined()
    expect(mockDbClient.query).toHaveBeenCalledTimes(1)
  })

  it('should update without changing embedding if content is not provided', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const existingDoc = { id: '123', name: 'Title', content: 'old' }
    const patch = { name: 'New Title' }
    const updatedDoc = { ...existingDoc, ...patch }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] })
      .mockResolvedValueOnce({ rows: [updatedDoc] })

    const result = await db.updateDocument('123', patch)

    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
      '123',
      null,
      null,
      'New Title',
      null,
      null,
      null,
    ])
    expect(result).toEqual(updatedDoc)
  })

  it('should return undefined if update returns no rows', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const existingDoc = { id: '123', name: 'Title', content: 'old' }
    const patch = { content: 'new' }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] }) // get by id
      .mockResolvedValueOnce({ rows: [] }) // update returns empty

    const result = await db.updateDocument('123', patch)
    expect(result).toBeUndefined()
    expect(mockLogger.warn).toHaveBeenCalledWith('updateDocument failed: document not found', {
      id: '123',
    })
  })
})
