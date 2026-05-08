import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.addDocument', () => {
  const { mockDbClient, mockEmbeddingProvider } = setupUnitTestMocks()

  it('should insert a new document', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const docInput = { projectId: 'p1', type: 't1', src: 's1', name: 'Title', content: 'Hello' }
    const expectedDoc = { ...docInput, id: '123' }
    mockDbClient.query.mockResolvedValue({ rows: [expectedDoc] })

    const result = await db.addDocument(docInput)

    // addDocument embeds buildEmbeddingTextForDoc(type, content, name, src)
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(1)
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      'p1',
      't1',
      's1',
      'Title',
      'Hello',
      '[0.1,0.2,0.3]',
      null,
    ])
    expect(result).toEqual(expectedDoc)
  })

  it('falls back to empty content when input.content is undefined', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const docInput = {
      projectId: 'p1',
      type: 't1',
      src: 's1',
      name: 'Title',
    } as any
    mockDbClient.query.mockResolvedValue({ rows: [{ ...docInput, content: '', id: '123' }] })

    await db.addDocument(docInput)

    // The 5th positional arg is the content column.
    expect(mockDbClient.query.mock.calls.at(-1)[1][4]).toBe('')
  })
})
