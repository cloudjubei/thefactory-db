import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Entities.updateEntity', () => {
  const { mockDbClient, mockLogger, mockEmbeddingProvider } = setupUnitTestMocks()

  it('should update an existing entity (including embedding when content is provided)', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const existing = { id: '123', content: { a: 1 }, shouldEmbed: true }
    const patch = { content: { a: 2 } }
    const updated = { ...existing, ...patch }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existing] }) // get by id
      .mockResolvedValueOnce({ rows: [updated] }) // update

    const result = await db.updateEntity('123', patch as any)

    expect(mockDbClient.query).toHaveBeenNthCalledWith(1, 'FAKE_SQL', ['123'])
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(JSON.stringify({ a: 2 }))
    expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
      '123',
      null,
      { a: 2 },
      null,
      JSON.stringify({ a: 2 }),
      '[0.1,0.2,0.3]',
      null,
    ])
    expect(result).toEqual(updated)
  })

  it('should return undefined if entity does not exist', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })

    const result = await db.updateEntity('123', { content: { a: 2 } } as any)
    expect(result).toBeUndefined()
    expect(mockDbClient.query).toHaveBeenCalledTimes(1)
  })

  it('should update without changing embedding if content is not provided', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const existing = { id: '123', content: { a: 1 }, shouldEmbed: true }
    const patch = { type: 'New Type' }
    const updated = { ...existing, ...patch }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [updated] })

    const result = await db.updateEntity('123', patch as any)

    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
      '123',
      'New Type',
      null,
      null,
      null,
      null,
      null,
    ])
    expect(result).toEqual(updated)
  })

  it('should clear embedding if shouldEmbed is updated to false', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const existing = { id: '123', content: { a: 1 }, shouldEmbed: true }
    const patch = { shouldEmbed: false }
    const updated = { ...existing, ...patch }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [updated] })

    const result = await db.updateEntity('123', patch as any)

    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query).toHaveBeenNthCalledWith(2, 'FAKE_SQL', [
      '123',
      null,
      null,
      false,
      null,
      null,
      null,
    ])
    expect(result).toEqual(updated)
  })

  it('should return undefined if update returns no rows', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const existing = { id: '123', content: { a: 1 }, shouldEmbed: true }
    const patch = { content: { a: 2 } }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [existing] })
      .mockResolvedValueOnce({ rows: [] })

    const result = await db.updateEntity('123', patch as any)
    expect(result).toBeUndefined()
    expect(mockLogger.warn).not.toHaveBeenCalled()
  })
})
