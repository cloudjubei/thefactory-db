import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.upsertEntity', () => {
  const { mockDbClient, mockEmbeddingProvider } = setupUnitTestMocks()

  it('embeds + passes all eight positional params including externalKey', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const input = { projectId: 'p1', type: 'stock-quote', content: { v: 1 }, externalKey: 'AAPL' }
    const expected = { ...input, id: '123' }
    mockDbClient.query.mockResolvedValue({ rows: [expected] })

    const result = await db.upsertEntity(input as any)

    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(JSON.stringify({ v: 1 }))
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      'p1',
      'stock-quote',
      { v: 1 },
      true,
      JSON.stringify({ v: 1 }),
      '[0.1,0.2,0.3]',
      null,
      'AAPL',
    ])
    expect(result).toEqual(expected)
  })

  it('skips embedding when shouldEmbed is false and passes a null externalKey for keyless input', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const input = { projectId: 'p1', type: 't', content: { v: 1 }, shouldEmbed: false }
    mockDbClient.query.mockResolvedValue({ rows: [{ ...input, id: '1' }] })

    await db.upsertEntity(input as any)

    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    const params = mockDbClient.query.mock.calls.at(-1)![1]
    expect(params[5]).toBeNull() // embedding literal
    expect(params[7]).toBeNull() // externalKey
  })
})
