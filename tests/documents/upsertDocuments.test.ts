import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

describe('Documents.upsertDocuments', () => {
  const { mockDbClient, mockLogger, mockEmbeddingProvider } = setupUnitTestMocks()

  it('returns [] for an empty inputs array without touching the db', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const callsBefore = mockDbClient.query.mock.calls.length

    const result = await db.upsertDocuments([])

    expect(result).toEqual([])
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query.mock.calls.length).toBe(callsBefore)
  })

  it('treats undefined content as empty string in the change-detection query', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // getChangingDocuments

    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1' }] as any
    await db.upsertDocuments(inputs)

    // 3rd positional arg is the parallel `contents` array.
    const contentsArg = mockDbClient.query.mock.calls.at(-1)[1][2]
    expect(contentsArg).toEqual([''])
  })

  it('treats undefined content as empty string in the embedding text', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1' }] as any

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments → flagged
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: '1', src: 's1' }] }) // upsert
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    await db.upsertDocuments(inputs)

    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(expect.any(String))
    // The embedded text is a join of [type, name, src, content] with falsy parts dropped.
    // With content === '' (falsy), the embedded string should not contain duplicate newlines.
    const embeddedText = (mockEmbeddingProvider.embed.mock.calls.at(-1) as any[])[0]
    expect(embeddedText).toBe('t\nn1\ns1')
  })

  it('returns [] when getChangingDocuments reports nothing changed', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // getChangingDocuments

    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]
    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([])
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockLogger.info).toHaveBeenCalledWith('upsertDocuments: no documents needed updating.')
  })

  it('embeds, BEGINs, upserts each changed doc, and COMMITs', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]

    const upserted1 = { id: '1', src: 's1' }
    const upserted2 = { id: '2', src: 's2' }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's1' }, { src: 's2' }] }) // getChangingDocuments
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [upserted1] }) // upsert s1
      .mockResolvedValueOnce({ rows: [upserted2] }) // upsert s2
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([upserted1, upserted2])
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(2)
    const calls = mockDbClient.query.mock.calls.map((c: any[]) => c[0])
    expect(calls).toContain('BEGIN')
    expect(calls).toContain('COMMIT')
    expect(calls).not.toContain('ROLLBACK')
  })

  it('skips documents not flagged as changing while still upserting the changed ones', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's2' }] }) // only s2 changed
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: '2', src: 's2' }] }) // upsert s2
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([{ id: '2', src: 's2' }])
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(1)
  })

  it('rolls back and rethrows when an upsert query fails', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }]

    const boom = new Error('upsert blew up')
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockRejectedValueOnce(boom) // upsert throws
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    await expect(db.upsertDocuments(inputs)).rejects.toBe(boom)

    const calls = mockDbClient.query.mock.calls.map((c: any[]) => c[0])
    expect(calls).toContain('BEGIN')
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('COMMIT')
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Error in batch upsert, rolling back transaction',
      boom,
    )
  })

  it('rolls back and rethrows when embedding generation fails', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }]

    // Order of queries when embed fails: 1) getChangingDocuments, 2) ROLLBACK in catch.
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
      .mockResolvedValueOnce({ rows: [] }) // ROLLBACK

    const boom = new Error('embed dead')
    mockEmbeddingProvider.embed.mockRejectedValueOnce(boom)

    await expect(db.upsertDocuments(inputs)).rejects.toBe(boom)
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Error in batch upsert, rolling back transaction',
      boom,
    )

    const calls = mockDbClient.query.mock.calls.map((c: any[]) => c[0])
    expect(calls).toContain('ROLLBACK')
    expect(calls).not.toContain('BEGIN')
  })

  it('skips a row in the result if upsertDocument returns no rows', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's1' }, { src: 's2' }] }) // getChangingDocuments
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // upsert s1 → no row
      .mockResolvedValueOnce({ rows: [{ id: '2', src: 's2' }] }) // upsert s2
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const result = await db.upsertDocuments(inputs)
    expect(result).toEqual([{ id: '2', src: 's2' }])
  })
})

describe('Documents.upsertDocument', () => {
  const { mockDbClient } = setupUnitTestMocks()

  it('delegates to upsertDocuments and returns the first row', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const input = { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }
    const upserted = { id: '1', src: 's1' }

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [upserted] }) // upsert
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    const result = await db.upsertDocument(input)
    expect(result).toEqual(upserted)
  })

  it('returns undefined when nothing was upserted', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const input = { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }

    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // nothing changed

    const result = await db.upsertDocument(input)
    expect(result).toBeUndefined()
  })
})
