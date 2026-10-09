import { beforeEach, describe, it, expect } from 'vitest'

import { CHUNKER_VERSION } from '../../src/chunking/chunkingConstants'
import {
  embeddedTexts,
  setupUnitTestMocks,
  statements,
  useTransactionClient,
} from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.addDocument', () => {
  const { mockDbClient, mockLogger, mockEmbeddingProvider } = setupUnitTestMocks()

  // The chunk-embedding lookup finds nothing stored.
  beforeEach(() => mockDbClient.query.mockResolvedValue({ rows: [] }))

  const docInput = { projectId: 'p1', type: 't1', src: 's1', name: 'Title', content: 'Hello' }

  it('inserts the document and its chunks in one transaction, embedding each chunk', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const expectedDoc = { ...docInput, id: '123' }
    const tx = useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [expectedDoc] } : { rows: [] },
    )

    const result = await db.addDocument(docInput)

    expect(embeddedTexts(mockEmbeddingProvider)).toEqual(['s1\nHello'])
    expect(statements(tx)).toEqual(['BEGIN', 'FAKE_SQL', 'FAKE_SQL', 'FAKE_SQL', 'COMMIT'])
    // No document-level vector: semantic search reads the chunks.
    expect(tx.query.mock.calls[1][1]).toEqual([
      'p1',
      't1',
      's1',
      'Title',
      'Hello',
      null,
      null,
      null,
      CHUNKER_VERSION,
    ])
    expect(tx.query.mock.calls[2][1]).toEqual(['123'])
    expect(tx.query.mock.calls[3][1].slice(0, 4)).toEqual(['123', 'p1', [0], ['text']])
    expect(tx.release).toHaveBeenCalledTimes(1)
    expect(result).toEqual(expectedDoc)
  })

  it('rolls back the document when its chunks cannot be written', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const boom = new Error('chunk insert failed')
    const tx = useTransactionClient(mockDbClient, (_sql, params) => {
      if (params?.length === 10) throw boom
      return params ? { rows: [{ ...docInput, id: '123' }] } : { rows: [] }
    })

    await expect(db.addDocument(docInput)).rejects.toBe(boom)

    expect(statements(tx).at(-1)).toBe('ROLLBACK')
    expect(statements(tx)).not.toContain('COMMIT')
  })

  // Migrations legitimately log at info during openDatabase, so this is scoped to the message.
  it('logs its entry line at debug, not info', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ ...docInput, id: '123' }] } : { rows: [] },
    )

    await db.addDocument(docInput)

    expect(mockLogger.debug).toHaveBeenCalledWith('addDocument', {
      projectId: 'p1',
      type: 't1',
      name: 'Title',
      src: 's1',
    })
    expect(mockLogger.info.mock.calls.filter((c: any[]) => c[0] === 'addDocument')).toEqual([])
  })

  it('falls back to empty content when input.content is undefined', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const tx = useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: '123' }] } : { rows: [] },
    )

    await db.addDocument({ projectId: 'p1', type: 't1', src: 's1', name: 'Title' } as any)

    expect(tx.query.mock.calls[1][1][4]).toBe('')
    expect(embeddedTexts(mockEmbeddingProvider)).toEqual(['s1\n'])
  })
})
