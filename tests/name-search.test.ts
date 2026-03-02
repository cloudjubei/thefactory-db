import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { SQL } from '../src/sql'

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
        const id = String(seq++)
        const ts = nowStr()
        const d: Doc = { id, projectId, type, src, name, content, createdAt: ts, updatedAt: ts, metadata }
        docs.push(d)
        return { rows: [d] }
      }

      if (sql === SQL.searchDocumentsByName) {
        const [query, limit, filterJson] = args as [string, number, string]
        const filters = JSON.parse(filterJson)
        if (typeof query !== 'string') throw new Error('Expected query to be string')
        if (typeof limit !== 'number') throw new Error('Expected limit to be number')
        if (!filters || typeof filters !== 'object') throw new Error('Expected filterJson to parse to object')
        return { rows: docs.slice(0, Math.min(limit, docs.length)) }
      }

      if (sql === SQL.searchDocumentsQuery) {
        return { rows: docs.slice().reverse() }
      }

      return { rows: [] }
    }),
    end: vi.fn(),
    _docs: docs,
  }

  return client
}

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')

describe('Direct name/src search (contract + interleaving)', () => {
  const mockDb = createMockDb()
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const mockEmb = { embed: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])) }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb._docs.splice(0, mockDb._docs.length)
    ;(openPostgres as unknown as any).mockResolvedValue(mockDb)
    ;(createLogger as unknown as any).mockReturnValue(mockLogger)
    ;(createLocalEmbeddingProvider as unknown as any).mockResolvedValue(mockEmb)
  })

  afterAll(async () => {
    await mockDb.end()
  })

  it('calls name/src SQL with [query, limit<=10, filterJson] and returns results', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    await db.addDocument({ projectId: 'p1', type: 'doc', src: 'a/b/c.md', name: 'Alpha', content: '' })
    await db.addDocument({ projectId: 'p1', type: 'doc', src: 'a/b/d.md', name: 'Alphabet', content: '' })

    const out = await db.searchDocuments({ projectIds: ['p1'], query: 'alpha', limit: 999 })
    expect(out.length).toBeGreaterThan(0)

    const nameCall = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsByName)
    expect(nameCall).toBeTruthy()
    expect(nameCall[1][0]).toBe('alpha')
    expect(nameCall[1][1]).toBe(10)
    expect(typeof nameCall[1][2]).toBe('string')
  })

  it('interleaves name results with hybrid results deterministically and de-dupes by id', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    const d1 = await db.addDocument({ projectId: 'p1', type: 'doc', src: 'a/1.md', name: 'Alpha', content: '' })
    const d2 = await db.addDocument({ projectId: 'p1', type: 'doc', src: 'a/2.md', name: 'Beta', content: '' })
    const d3 = await db.addDocument({ projectId: 'p1', type: 'doc', src: 'a/3.md', name: 'Gamma', content: '' })

    const out = await db.searchDocuments({ projectIds: ['p1'], query: 'x', limit: 10 })
    expect(out.map((r: any) => r.id)).toEqual([d1.id, d3.id, d2.id])
  })
})
