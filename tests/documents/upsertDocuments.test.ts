import { describe, it, expect } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

// Migrations legitimately log at info during openDatabase, so the level guards below are scoped to
// this module's own messages rather than asserting info was never called at all.
function messagesStartingWith(spy: any, prefix: string): string[] {
  return spy.mock.calls
    .map((c: any[]) => c[0])
    .filter((m: unknown): m is string => typeof m === 'string' && m.startsWith(prefix))
}

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
    // Per-operation chatter is DEBUG, not info: at info this printed a line per batch
    // (plus every upserted path) and buried the log during a large project's ingestion.
    expect(mockLogger.debug).toHaveBeenCalledWith('upsertDocuments: no documents needed updating.')
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'upsertDocuments: no documents needed updating.',
    )
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

  it('logs every per-batch progress line at debug and none at info', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments → only s1
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: '1', src: 's1' }] }) // upsert s1
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    await db.upsertDocuments(inputs)

    expect(messagesStartingWith(mockLogger.debug, 'upsertDocuments:')).toEqual([
      'upsertDocuments: received a batch of 2 documents',
      'upsertDocuments: 1 of 2 need updating.',
      'upsertDocuments: upserted 1 documents.',
    ])
    expect(messagesStartingWith(mockLogger.info, 'upsertDocuments:')).toEqual([])
  })

  it('logs a bare count on the success line, never the upserted src paths', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 'src/deep/nested/one.ts', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 'src/deep/nested/two.ts', name: 'n2', content: 'b' },
    ]

    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ src: inputs[0].src }, { src: inputs[1].src }] })
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ id: '1', src: inputs[0].src }] })
      .mockResolvedValueOnce({ rows: [{ id: '2', src: inputs[1].src }] })
      .mockResolvedValueOnce({ rows: [] }) // COMMIT

    await db.upsertDocuments(inputs)

    // Exactly one argument: re-attaching an `upsertedDocs.map(d => d.src)` payload flooded the log
    // with one file path per document on every ingestion batch.
    const successCall = mockLogger.debug.mock.calls.find(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('upsertDocuments: upserted'),
    )
    expect(successCall).toEqual(['upsertDocuments: upserted 2 documents.'])

    const everythingLogged = JSON.stringify([
      ...mockLogger.debug.mock.calls,
      ...mockLogger.info.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
    ])
    expect(everythingLogged).not.toContain('src/deep/nested/one.ts')
    expect(everythingLogged).not.toContain('src/deep/nested/two.ts')
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
  const { mockDbClient, mockLogger } = setupUnitTestMocks()

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

  it('logs its entry line at debug, not info', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // nothing changed

    await db.upsertDocument({ projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' })

    expect(mockLogger.debug).toHaveBeenCalledWith('upsertDocument', { src: 's1' })
    expect(mockLogger.info.mock.calls.filter((c: any[]) => c[0] === 'upsertDocument')).toEqual([])
  })

  it('returns undefined when nothing was upserted', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const input = { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }

    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // nothing changed

    const result = await db.upsertDocument(input)
    expect(result).toBeUndefined()
  })
})
