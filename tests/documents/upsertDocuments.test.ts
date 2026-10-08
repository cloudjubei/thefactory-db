import { describe, it, expect, vi } from 'vitest'

import { setupUnitTestMocks } from '../utils/unitTestMocks'
import { openDatabase } from '../../src/index'

// Migrations legitimately log at info during openDatabase, so the level guards below are scoped to
// this module's own messages rather than asserting info was never called at all.
function messagesStartingWith(spy: any, prefix: string): string[] {
  return spy.mock.calls
    .map((c: any[]) => c[0])
    .filter((m: unknown): m is string => typeof m === 'string' && m.startsWith(prefix))
}

type TransactionResponder = (sql: string, params?: unknown[]) => { rows: unknown[] }

/** Checks out a stand-in connection from the mocked pool; the batch transaction runs on it. */
function useTransactionClient(mockDbClient: any, respond: TransactionResponder) {
  const tx = {
    query: vi.fn(async (sql: string, params?: unknown[]) => respond(sql, params)),
    release: vi.fn(),
  }
  mockDbClient.connect = vi.fn().mockResolvedValue(tx)
  return tx
}

function statements(tx: { query: { mock: { calls: any[][] } } }): string[] {
  return tx.query.mock.calls.map((c) => c[0])
}

/** The error Postgres raises when a document's lexemes exceed the 1 MB tsvector ceiling. */
function tooLargeForTsvector(): Error {
  return Object.assign(
    new Error('string is too long for tsvector (1066250 bytes, max 1048575 bytes)'),
    {
      code: '54000',
    },
  )
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

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: '1', src: 's1' }] } : { rows: [] },
    )

    await db.upsertDocuments(inputs)

    expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(expect.any(String))
    // The embedded text is a join of [type, name, src, content] with falsy parts dropped.
    // With content === '' (falsy), the embedded string should not contain duplicate newlines.
    const embeddedText = (mockEmbeddingProvider.embed.mock.calls.at(-1) as any[])[0]
    expect(embeddedText).toBe('t\nn1\ns1')
  })

  it('strips NUL characters before change detection, embedding and storage', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a\u0000b\u0000' },
    ]

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
    const tx = useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: '1', src: 's1' }] } : { rows: [] },
    )

    await db.upsertDocuments(inputs)

    expect(mockDbClient.query.mock.calls.at(-1)[1][2]).toEqual(['ab'])
    expect((mockEmbeddingProvider.embed.mock.calls.at(-1) as any[])[0]).toBe('t\nn1\ns1\nab')
    const upsertParams = tx.query.mock.calls.find((c: any[]) => c[1])?.[1]
    expect(upsertParams?.[4]).toBe('ab')
  })

  it('returns [] when getChangingDocuments reports nothing changed', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // getChangingDocuments
    const tx = useTransactionClient(mockDbClient, () => ({ rows: [] }))

    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]
    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([])
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(tx.query).not.toHaveBeenCalled()
    // Per-operation chatter is DEBUG, not info: at info this printed a line per batch
    // (plus every upserted path) and buried the log during a large project's ingestion.
    expect(mockLogger.debug).toHaveBeenCalledWith('upsertDocuments: no documents needed updating.')
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      'upsertDocuments: no documents needed updating.',
    )
  })

  it('upserts each changed doc in its own savepoint inside one transaction on a dedicated connection', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]

    const upserted1 = { id: '1', src: 's1' }
    const upserted2 = { id: '2', src: 's2' }

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }, { src: 's2' }] })
    const tx = useTransactionClient(mockDbClient, (_sql, params) => {
      if (!params) return { rows: [] }
      return { rows: [params[2] === 's1' ? upserted1 : upserted2] }
    })

    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([upserted1, upserted2])
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(2)
    // A pool hands each query to whichever connection is free, so BEGIN/COMMIT on the pool did not
    // bracket the upserts; the whole transaction must run on the one connection it checked out.
    expect(statements(tx)).toEqual([
      'BEGIN',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'RELEASE SAVEPOINT document_upsert',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'RELEASE SAVEPOINT document_upsert',
      'COMMIT',
    ])
    const poolStatements = mockDbClient.query.mock.calls.map((c: any[]) => c[0])
    expect(poolStatements).not.toContain('BEGIN')
    expect(poolStatements).not.toContain('COMMIT')
    expect(tx.release).toHaveBeenCalledTimes(1)
  })

  it('logs every per-batch progress line at debug and none at info', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // only s1 changed
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: '1', src: 's1' }] } : { rows: [] },
    )

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

    mockDbClient.query.mockResolvedValueOnce({
      rows: [{ src: inputs[0].src }, { src: inputs[1].src }],
    })
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: params[2], src: params[2] }] } : { rows: [] },
    )

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

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's2' }] }) // only s2 changed
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: '2', src: 's2' }] } : { rows: [] },
    )

    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([{ id: '2', src: 's2' }])
    expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(1)
  })

  it('stores a document Postgres cannot index flagged non-indexable and commits its batchmates', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const metadata = { ext: 'json' }
    const inputs = [
      { projectId: 'p1', type: 't', src: 'big.json', name: 'big.json', content: 'xyz', metadata },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]
    const flagged = { id: '1', src: 'big.json', nonIndexableReason: 'too-large' }

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 'big.json' }, { src: 's2' }] })
    const tx = useTransactionClient(mockDbClient, (_sql, params) => {
      if (!params) return { rows: [] }
      if (params[6] === 'too-large') return { rows: [flagged] }
      if (params[2] === 'big.json') throw tooLargeForTsvector()
      return { rows: [{ id: '2', src: 's2' }] }
    })

    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([flagged, { id: '2', src: 's2' }])
    expect(statements(tx)).toEqual([
      'BEGIN',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'ROLLBACK TO SAVEPOINT document_upsert',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'RELEASE SAVEPOINT document_upsert',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'RELEASE SAVEPOINT document_upsert',
      'COMMIT',
    ])
    const flaggedParams = tx.query.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.[6] === 'too-large')
    // The content travels only so Postgres can hash it: an unchanged file then matches its stored hash
    // and is not embedded and rejected again on every ingestion.
    expect(flaggedParams).toEqual(['p1', 't', 'big.json', 'big.json', 'xyz', metadata, 'too-large'])
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  it('warns with the path, reason and size of a document stored as non-indexable', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      {
        projectId: 'p1',
        type: 't',
        src: 'data/BTC.json',
        name: 'BTC.json',
        content: 'é'.repeat(3),
      },
    ]

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 'data/BTC.json' }] })
    useTransactionClient(mockDbClient, (_sql, params) => {
      if (!params) return { rows: [] }
      if (params[6] === 'too-large') return { rows: [{ id: '1' }] }
      throw tooLargeForTsvector()
    })

    await db.upsertDocuments(inputs)

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'upsertDocuments: data/BTC.json cannot be indexed (too-large, 6 bytes); stored as non-indexable without its content',
    )
  })

  it('skips a document that fails for another reason, logs it, and commits its batchmates', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]
    const boom = Object.assign(new Error('value too long for type'), { code: '22001' })

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }, { src: 's2' }] })
    const tx = useTransactionClient(mockDbClient, (_sql, params) => {
      if (!params) return { rows: [] }
      if (params[2] === 's1') throw boom
      return { rows: [{ id: '2', src: 's2' }] }
    })

    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([{ id: '2', src: 's2' }])
    expect(statements(tx)).toContain('ROLLBACK TO SAVEPOINT document_upsert')
    expect(statements(tx).at(-1)).toBe('COMMIT')
    expect(tx.query.mock.calls.map((c: any[]) => c[1]).filter(Boolean)).toHaveLength(2)
    expect(mockLogger.error).toHaveBeenCalledWith(
      'upsertDocuments: could not store s1, skipped it',
      boom,
    )
  })

  it('skips a document whose non-indexable write also fails, and commits its batchmates', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]
    const boom = new Error('flagged write failed')

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }, { src: 's2' }] })
    const tx = useTransactionClient(mockDbClient, (_sql, params) => {
      if (!params) return { rows: [] }
      if (params[2] !== 's1') return { rows: [{ id: '2', src: 's2' }] }
      if (params[6] === 'too-large') throw boom
      throw tooLargeForTsvector()
    })

    const result = await db.upsertDocuments(inputs)

    expect(result).toEqual([{ id: '2', src: 's2' }])
    expect(
      statements(tx).filter((s) => s === 'ROLLBACK TO SAVEPOINT document_upsert'),
    ).toHaveLength(2)
    expect(statements(tx).at(-1)).toBe('COMMIT')
    expect(mockLogger.error).toHaveBeenCalledWith(
      'upsertDocuments: could not store s1, skipped it',
      boom,
    )
  })

  it('rolls back on the same connection, rethrows and releases it when COMMIT fails', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }]
    const boom = new Error('commit blew up')

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] })
    const tx = useTransactionClient(mockDbClient, (sql, params) => {
      if (sql === 'COMMIT') throw boom
      return params ? { rows: [{ id: '1', src: 's1' }] } : { rows: [] }
    })

    await expect(db.upsertDocuments(inputs)).rejects.toBe(boom)

    expect(statements(tx).at(-1)).toBe('ROLLBACK')
    expect(tx.release).toHaveBeenCalledTimes(1)
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Error in batch upsert, rolling back transaction',
      boom,
    )
  })

  it('rethrows the original error and releases the connection when ROLLBACK also fails', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }]
    const boom = new Error('commit blew up')
    const rollbackBoom = new Error('connection gone')

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] })
    const tx = useTransactionClient(mockDbClient, (sql, params) => {
      if (sql === 'COMMIT') throw boom
      if (sql === 'ROLLBACK') throw rollbackBoom
      return params ? { rows: [{ id: '1', src: 's1' }] } : { rows: [] }
    })

    await expect(db.upsertDocuments(inputs)).rejects.toBe(boom)

    expect(tx.release).toHaveBeenCalledWith(rollbackBoom)
    expect(mockLogger.error).toHaveBeenCalledWith('upsertDocuments: ROLLBACK failed', rollbackBoom)
  })

  it('rethrows embedding failures without opening a transaction', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }]

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
    const tx = useTransactionClient(mockDbClient, () => ({ rows: [] }))
    const boom = new Error('embed dead')
    mockEmbeddingProvider.embed.mockRejectedValueOnce(boom)

    await expect(db.upsertDocuments(inputs)).rejects.toBe(boom)

    expect(mockDbClient.connect).not.toHaveBeenCalled()
    expect(tx.query).not.toHaveBeenCalled()
    expect(mockLogger.error).toHaveBeenCalledWith('upsertDocuments: embedding failed', boom)
  })

  it('skips a row in the result if upsertDocument returns no rows', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ]

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }, { src: 's2' }] })
    useTransactionClient(mockDbClient, (_sql, params) => {
      if (!params) return { rows: [] }
      return params[2] === 's1' ? { rows: [] } : { rows: [{ id: '2', src: 's2' }] }
    })

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

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
    const tx = useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [upserted] } : { rows: [] },
    )

    const result = await db.upsertDocument(input)
    expect(tx.release).toHaveBeenCalledTimes(1)
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
