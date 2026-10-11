import { describe, it, expect } from 'vitest'

import {
  embeddedTexts,
  setupUnitTestMocks,
  statements,
  useTransactionClient,
} from '../utils/unitTestMocks'

import { CHUNKER_VERSION } from '../../src/chunking/chunkingConstants'
import { openDatabase } from '../../src/index'

describe('Documents.updateDocument', () => {
  const { mockDbClient, mockLogger, mockEmbeddingProvider } = setupUnitTestMocks()

  const existingDoc = { id: '123', projectId: 'p1', src: 's1', name: 'Title', content: 'old' }

  it('re-chunks new content and writes the row and its chunks in one transaction', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const updatedDoc = { ...existingDoc, content: 'new' }
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] }) // get by id
      .mockResolvedValueOnce({ rows: [] }) // chunk-embedding lookup
    const tx = useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [updatedDoc] } : { rows: [] },
    )

    const result = await db.updateDocument('123', { content: 'new' })

    expect(embeddedTexts(mockEmbeddingProvider)).toEqual(['s1\nnew'])
    expect(statements(tx)).toEqual(['BEGIN', 'FAKE_SQL', 'FAKE_SQL', 'FAKE_SQL', 'COMMIT'])
    expect(tx.query.mock.calls[1][1]).toEqual([
      '123',
      null,
      null,
      null,
      'new',
      null,
      null,
      CHUNKER_VERSION,
    ])
    expect(tx.query.mock.calls[2][1]).toEqual(['123'])
    expect(tx.query.mock.calls[3][1].slice(0, 2)).toEqual(['123', 'p1'])
    expect(result).toEqual(updatedDoc)
  })

  it('re-chunks the stored content under a new path, since a chunk header names the path', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] })
      .mockResolvedValueOnce({ rows: [] })
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ ...existingDoc, src: 'moved/s1' }] } : { rows: [] },
    )

    await db.updateDocument('123', { src: 'moved/s1' })

    expect(embeddedTexts(mockEmbeddingProvider)).toEqual(['moved/s1\nold'])
  })

  it('updates other fields without re-chunking or a transaction', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const updatedDoc = { ...existingDoc, name: 'New Title' }
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] })
      .mockResolvedValueOnce({ rows: [updatedDoc] })
    const tx = useTransactionClient(mockDbClient, () => ({ rows: [] }))

    const result = await db.updateDocument('123', { name: 'New Title' })

    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(tx.query).not.toHaveBeenCalled()
    expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
      '123',
      null,
      null,
      'New Title',
      null,
      null,
      null,
      CHUNKER_VERSION,
    ])
    expect(result).toEqual(updatedDoc)
  })

  // Migrations legitimately log at info during openDatabase, so this is scoped to the message.
  it('logs its entry line at debug, not info', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] })
      .mockResolvedValueOnce({ rows: [{ ...existingDoc, name: 'New Title' }] })

    await db.updateDocument('123', { name: 'New Title' })

    expect(mockLogger.debug).toHaveBeenCalledWith('updateDocument', {
      id: '123',
      name: 'New Title',
    })
    expect(mockLogger.info.mock.calls.filter((c: any[]) => c[0] === 'updateDocument')).toEqual([])
  })

  it('returns undefined without writing when the document does not exist', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [] })

    const result = await db.updateDocument('123', { content: 'new' })

    expect(result).toBeUndefined()
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
  })

  it('treats patch.content === null as clearing the content', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] })
      .mockResolvedValueOnce({ rows: [] })
    const tx = useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ ...existingDoc, content: '' }] } : { rows: [] },
    )

    await db.updateDocument('123', { content: null } as any)

    expect(tx.query.mock.calls[1][1][4]).toBe('')
    expect(embeddedTexts(mockEmbeddingProvider)).toEqual(['s1\n'])
  })

  it('returns undefined and writes no chunks when the update finds no row', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existingDoc] })
      .mockResolvedValueOnce({ rows: [] })
    const tx = useTransactionClient(mockDbClient, () => ({ rows: [] }))

    const result = await db.updateDocument('123', { content: 'new' })

    expect(result).toBeUndefined()
    expect(statements(tx)).toEqual(['BEGIN', 'FAKE_SQL', 'COMMIT'])
    expect(mockLogger.warn).toHaveBeenCalledWith('updateDocument failed: document not found', {
      id: '123',
    })
  })
})
