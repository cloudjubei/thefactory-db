import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'
import { openPostgres } from '../../src/connection'
import { createLogger } from '../../src/logger'
import { createLocalEmbeddingProvider } from '../../src/utils/embeddings'
import { SQL } from '../../src/sql'
import { attachMigrationSupport } from '../utils/unitTestMocks'

vi.mock('../../src/connection')
vi.mock('../../src/logger')
vi.mock('../../src/utils/embeddings')

// In-memory mock DB for name/src tests.
// We don't replicate SQL ranking; we validate call shapes + interleaving.
function createMockDb() {
  type Doc = {
    id: string
    projectId: string
    type: string
    name: string
    content: string
    src: string
    createdAt: string
    updatedAt: string
    metadata: any
  }

  const docs: Doc[] = []
  let seq = 1

  function nowStr() {
    return new Date().toISOString().replace('Z', 'Z')
  }

  const client = {
    query: vi.fn(async (sql: string, args?: any[]) => {
      if (sql === SQL.insertDocument) {
        const [projectId, type, src, name, content, _embeddingLit, metadata] = args as [
          string,
          string,
          string,
          string,
          string,
          string,
          any,
        ]
        const row: Doc = {
          id: String(seq++),
          projectId,
          type,
          name,
          content,
          src,
          createdAt: nowStr(),
          updatedAt: nowStr(),
          metadata: metadata ?? null,
        }
        docs.push(row)
        return { rows: [row] }
      }

      if (sql === SQL.searchDocumentsQuery) {
        // For these tests, just return all docs in reverse insertion order.
        return { rows: docs.slice().reverse() }
      }

      return { rows: [] }
    }),
    end: vi.fn(),
    _docs: docs,
  }

  return withDocumentTransactions(attachMigrationSupport(client))
}

/**
 * A connection that answers the migration runner's lock and version queries from the migration
 * client and hands every other statement (a document write's transaction) to the pool fake.
 */
function withDocumentTransactions(client: any) {
  const migrationConnect = client.connect
  client.connect = vi.fn(async () => {
    const lock = await migrationConnect()
    return {
      query: (sql: string, args?: unknown[]) =>
        /advisory|schema_version|thefactory\./i.test(sql)
          ? lock.query(sql)
          : client.query(sql, args),
      release: vi.fn(),
    }
  })
  return client
}

describe('Direct name/src search (contract + interleaving)', () => {
  const mockDb = createMockDb()
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const mockEmb = {
    embed: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])),
    embedBatch: vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array([0.1, 0.2, 0.3])),
    ),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb._docs.splice(0, mockDb._docs.length)

    vi.mocked(openPostgres).mockResolvedValue(mockDb as any)
    vi.mocked(createLogger).mockReturnValue(mockLogger as any)
    vi.mocked(createLocalEmbeddingProvider).mockResolvedValue(mockEmb as any)
  })

  afterAll(async () => {
    await mockDb.end()
  })

  it('returns name/src results when query matches name', async () => {
    const db = await openDatabase({ connectionString: 'test' })

    await db.addDocument({
      projectId: 'p',
      type: 't',
      name: 'Alpha',
      src: 's1',
      content: 'some content',
    })
    await db.addDocument({
      projectId: 'p',
      type: 't',
      name: 'Beta',
      src: 's2',
      content: 'other content',
    })

    const res = await db.searchDocuments({ query: 'Alpha', limit: 10 })
    expect(res.length).toBeGreaterThan(0)
    expect(res.some((d: any) => d.name === 'Alpha')).toBe(true)
  })

  it('returns [] for empty query', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const res = await db.searchDocuments({ query: '   ', limit: 10 })
    expect(res).toEqual([])
  })
})
