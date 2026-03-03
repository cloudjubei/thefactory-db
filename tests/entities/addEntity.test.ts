import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.addEntity', () => {
  const { mockDbClient, mockEmbeddingProvider } = setupUnitTestMocks()

  it('should insert a new entity', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const entityInput = { projectId: 'p1', type: 't1', content: { a: 1 } }
    const expected = { ...entityInput, id: '123' }
    mockDbClient.query.mockResolvedValue({ rows: [expected] })

    const result = await db.addEntity(entityInput as any)

    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(JSON.stringify({ a: 1 }))
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      'p1',
      't1',
      { a: 1 },
      true,
      JSON.stringify({ a: 1 }),
      '[0.1,0.2,0.3]',
      null,
    ])
    expect(result).toEqual(expected)
  })

  it('should not embed if shouldEmbed is false', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const entityInput = {
      projectId: 'p1',
      type: 't1',
      content: { a: 1 },
      shouldEmbed: false,
    }
    const expected = { ...entityInput, id: '123' }
    mockDbClient.query.mockResolvedValue({ rows: [expected] })

    const result = await db.addEntity(entityInput as any)

    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      'p1',
      't1',
      { a: 1 },
      false,
      JSON.stringify({ a: 1 }),
      null,
      null,
    ])
    expect(result).toEqual(expected)
  })
})
