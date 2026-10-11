import { createHash } from 'node:crypto'

import { beforeEach, describe, it, expect } from 'vitest'

import {
  embeddedTexts,
  setupUnitTestMocks,
  statements,
  useTransactionClient,
} from '../utils/unitTestMocks'

import { CHUNKER_VERSION } from '../../src/chunking/chunkingConstants'
import { openDatabase } from '../../src/index'

// Migrations legitimately log at info during openDatabase, so the level guards below are scoped to
// this module's own messages rather than asserting info was never called at all.
function messagesStartingWith(spy: any, prefix: string): string[] {
  return spy.mock.calls
    .map((c: any[]) => c[0])
    .filter((m: unknown): m is string => typeof m === 'string' && m.startsWith(prefix))
}

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex')

/** The error Postgres raises when a document's lexemes exceed the 1 MB tsvector ceiling. */
function tooLargeForTsvector(): Error {
  return Object.assign(
    new Error('string is too long for tsvector (1066250 bytes, max 1048575 bytes)'),
    {
      code: '54000',
    },
  )
}

/** A document row write: `upsertDocument` takes 9 parameters, the chunk statements 1 or 10. */
const isDocumentWrite = (params: unknown) => Array.isArray(params) && params.length === 9

type PoolCall = [sql: string, params?: unknown[]]

describe('Documents.upsertDocuments', () => {
  const { mockDbClient, mockLogger, mockEmbeddingProvider } = setupUnitTestMocks()
  const poolCalls = (): PoolCall[] => mockDbClient.query.mock.calls

  // Anything not scripted with a `...Once` — the chunk-embedding lookup — finds nothing stored.
  beforeEach(() => mockDbClient.query.mockResolvedValue({ rows: [] }))

  it('returns [] for an empty inputs array without touching the db', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const callsBefore = mockDbClient.query.mock.calls.length

    const result = await db.upsertDocuments([])

    expect(result).toEqual([])
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(mockDbClient.query.mock.calls.length).toBe(callsBefore)
  })

  it('detects changes from content hashes computed here, never sending the content itself', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // getChangingDocuments

    const inputs = [
      { projectId: 'p1', type: 't', src: 's1', name: 'n1' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'héllo' },
    ] as any
    await db.upsertDocuments(inputs)

    // Shipping every file's content to Postgres to hash it cost 244 MB per sync of eight projects.
    expect(mockDbClient.query.mock.calls.at(-1)[1]).toEqual([
      'p1',
      ['s1', 's2'],
      [sha1(''), sha1('héllo')],
      CHUNKER_VERSION,
    ])
  })

  it('ignores chunk versions in change detection when told to leave out outdated chunks', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [] }) // getChangingDocuments

    await db.upsertDocuments(
      [{ projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a' }],
      {
        includeOutdatedChunks: false,
      },
    )

    const changeCheck = poolCalls().find(
      (c) => Array.isArray(c[1]) && c[1].length === 4 && Array.isArray(c[1][2]),
    )
    expect(changeCheck?.[1][3]).toBeNull()
  })

  it('refreshes the fingerprints of unchanged documents without embedding them', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [] }) // getChangingDocuments: nothing changed
      .mockResolvedValueOnce({ rows: [] }) // refreshDocumentFingerprints

    await db.upsertDocuments([
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a', fingerprint: 'f1' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ])

    expect(mockDbClient.query.mock.calls.at(-1)[1]).toEqual(['p1', ['s1'], [sha1('a')], ['f1']])
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
  })

  it('refreshes no fingerprint for a document it is about to rewrite', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // s1 changed
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: '1', src: 's1' }] } : { rows: [] },
    )
    const before = mockDbClient.query.mock.calls.length

    await db.upsertDocuments([
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a', fingerprint: 'f1' },
    ])

    // A refresh sends [projectId, srcs, hashes, fingerprints]; only the change check and the
    // chunk-embedding lookup may reach the pool.
    const poolParams = poolCalls()
      .slice(before)
      .map((c) => c[1])
    expect(poolParams).toHaveLength(2)
    expect(poolParams.some((p) => Array.isArray(p?.[3]) && p[3][0] === 'f1')).toBe(false)
  })

  it('stores each rewritten document with its fingerprint', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }, { src: 's2' }] })
    const tx = useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: params[2], src: params[2] }] } : { rows: [] },
    )

    await db.upsertDocuments([
      { projectId: 'p1', type: 't', src: 's1', name: 'n1', content: 'a', fingerprint: 'f1' },
      { projectId: 'p1', type: 't', src: 's2', name: 'n2', content: 'b' },
    ])

    const fingerprints = tx.query.mock.calls
      .filter((c) => isDocumentWrite(c[1]))
      .map((c) => c[1]?.[7])
    expect(fingerprints).toEqual(['f1', null])
  })

  it('treats undefined content as empty string in the embedding text', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const inputs = [{ projectId: 'p1', type: 't', src: 's1', name: 'n1' }] as any

    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 's1' }] }) // getChangingDocuments
    useTransactionClient(mockDbClient, (_sql, params) =>
      params ? { rows: [{ id: '1', src: 's1' }] } : { rows: [] },
    )

    await db.upsertDocuments(inputs)

    // The embedded text is a join of [type, name, src, content] with falsy parts dropped.
    // With content === '' (falsy), the embedded string should not contain duplicate newlines.
    const embeddedText = embeddedTexts(mockEmbeddingProvider).at(-1)
    expect(embeddedText).toBe('s1\n')
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

    const changeCheck = poolCalls().find(
      (c) => Array.isArray(c[1]) && c[1].length === 4 && c[1][3] === CHUNKER_VERSION,
    )
    expect(changeCheck?.[1][2]).toEqual([sha1('ab')])
    expect(embeddedTexts(mockEmbeddingProvider).at(-1)).toBe('s1\nab')
    const upsertParams = tx.query.mock.calls.find((c) => c[1])?.[1]
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
    expect(embeddedTexts(mockEmbeddingProvider)).toHaveLength(2)
    // A pool hands each query to whichever connection is free, so BEGIN/COMMIT on the pool did not
    // bracket the upserts; the whole transaction must run on the one connection it checked out.
    expect(statements(tx)).toEqual([
      'BEGIN',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'FAKE_SQL',
      'FAKE_SQL',
      'RELEASE SAVEPOINT document_upsert',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'FAKE_SQL',
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
    expect(embeddedTexts(mockEmbeddingProvider)).toHaveLength(1)
  })

  it('stores a document Postgres cannot index flagged non-indexable and commits its batchmates', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const metadata = { ext: 'json' }
    const inputs = [
      {
        projectId: 'p1',
        type: 't',
        src: 'big.json',
        name: 'big.json',
        content: 'xyz',
        metadata,
        fingerprint: 'fp',
      },
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
      'FAKE_SQL',
      'RELEASE SAVEPOINT document_upsert',
      'SAVEPOINT document_upsert',
      'FAKE_SQL',
      'FAKE_SQL',
      'FAKE_SQL',
      'RELEASE SAVEPOINT document_upsert',
      'COMMIT',
    ])
    const flaggedParams = tx.query.mock.calls
      .map((c: any[]) => c[1])
      .find((p: any) => p?.[6] === 'too-large')
    // The content travels only so Postgres can hash it: an unchanged file then matches its stored hash
    // and is not embedded and rejected again on every ingestion.
    expect(flaggedParams).toEqual([
      'p1',
      't',
      'big.json',
      'big.json',
      'xyz',
      metadata,
      'too-large',
      'fp',
      CHUNKER_VERSION,
    ])
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  it('removes the chunks of a document stored as non-indexable and stores none for it', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValueOnce({ rows: [{ src: 'big.json' }] })
    const tx = useTransactionClient(mockDbClient, (_sql, params) => {
      if (!params) return { rows: [] }
      if (params[6] === 'too-large') return { rows: [{ id: '1', src: 'big.json' }] }
      if (params[2] === 'big.json') throw tooLargeForTsvector()
      return { rows: [] }
    })

    await db.upsertDocuments([
      { projectId: 'p1', type: 't', src: 'big.json', name: 'big.json', content: 'xyz' },
    ])

    const chunkWrites = tx.query.mock.calls.map((c) => c[1]).filter((p) => p?.[0] === '1')
    expect(chunkWrites).toEqual([['1']])
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
    expect(tx.query.mock.calls.filter((c) => isDocumentWrite(c[1]))).toHaveLength(2)
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
    expect(mockLogger.error).toHaveBeenCalledWith('documents: ROLLBACK failed', rollbackBoom)
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

  beforeEach(() => mockDbClient.query.mockResolvedValue({ rows: [] }))

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
