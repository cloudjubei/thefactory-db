import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'

// In-memory mock DB for name/src tests
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
      switch (sql) {
        case 'insertDocument': {
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
          const d: Doc = {
            id,
            projectId,
            type,
            name,
            content: content ?? '',
            src,
            createdAt: ts,
            updatedAt: ts,
            metadata: metadata ?? null,
          }
          docs.push(d)
          return { rows: [{ ...d }] }
        }
        case 'searchDocumentsQuery': {
          // Hybrid returns empty to isolate name/src behavior
          return { rows: [] }
        }
        case 'searchDocumentsByName': {
          const [queryText, limitRaw, filterJson] = args as [string, number, string]
          const limit = Math.min(10, Math.max(1, limitRaw ?? 10))
          let filtered = docs.slice()
          const filter = filterJson ? JSON.parse(filterJson) : {}
          if (filter.ids) filtered = filtered.filter((d) => filter.ids.includes(d.id))
          if (filter.types) filtered = filtered.filter((d) => filter.types.includes(d.type))
          if (filter.projectIds)
            filtered = filtered.filter((d) => filter.projectIds.includes(d.projectId))

          const tokens = (queryText || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]+/g, ' ')
            .split(/\s+/)
            .filter(Boolean)

          function strength(d: Doc): number {
            const name = (d.name || '').toLowerCase()
            const src = (d.src || '').toLowerCase()
            let s = 0
            for (const t of tokens) {
              s = Math.max(
                s,
                name === t ? 3 : name.startsWith(t) ? 2 : name.includes(t) ? 1 : 0,
                src === t ? 3 : src.startsWith(t) ? 2 : src.includes(t) ? 1 : 0,
              )
            }
            return s
          }

          const rows = filtered
            .map((d) => ({
              id: d.id,
              projectId: d.projectId,
              type: d.type,
              name: d.name,
              content: d.content,
              src: d.src,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
              metadata: d.metadata,
              textScore: null,
              keywordScore: null,
              vecScore: null,
              totalScore: strength(d),
            }))
            .filter((r) => r.totalScore > 0)
          rows.sort((a, b) => {
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore
            if (a.name !== b.name) return a.name < b.name ? -1 : 1
            return a.updatedAt < b.updatedAt ? 1 : -1
          })
          return { rows: rows.slice(0, limit) }
        }
        default:
          return { rows: [] }
      }
    }),
    end: vi.fn(),
    _docs: docs,
  }
  return client
}

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')
vi.mock('../src/utils', () => ({
  SQL: {
    insertDocument: 'insertDocument',
    searchDocumentsQuery: 'searchDocumentsQuery',
    searchDocumentsByName: 'searchDocumentsByName',
  },
}))

describe('Direct name/src search', () => {
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

  it('ranks equality > prefix > contains on name/src and deterministic tie-breakers', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'alpha', src: 'f1', content: '' }) // equality on name (3)
    await db.addDocument({ projectId, type: 't', name: 'alphabet', src: 'f2', content: '' }) // prefix (2)
    await db.addDocument({ projectId, type: 't', name: 'xxalpha', src: 'f3', content: '' }) // contains (1)
    await db.addDocument({ projectId, type: 't', name: 'zzz', src: 'alpha', content: '' }) // equality on src (3)

    const res = await db.searchDocuments({ query: 'alpha', projectIds: [projectId], limit: 10 })
    const names = res.map((r) => r.name)
    // Two equality-strength docs (name=alpha, src=alpha). Name ASC tie-breaker => 'alpha' then 'zzz'
    expect(names.slice(0, 4)).toEqual(['alpha', 'zzz', 'alphabet', 'xxalpha'])
  })

  it('enforces top-10 cap regardless of requested limit', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    for (let i = 0; i < 12; i++) {
      await db.addDocument({ projectId, type: 't', name: `doc-${i}`, src: `src-${i}`, content: '' })
    }
    const res = await db.searchDocuments({ query: 'doc', projectIds: [projectId], limit: 50 })
    // All matches are prefix/contains, but direct search is capped at 10 and hybrid empty
    expect(res.length).toBeLessThanOrEqual(10)
  })

  it('honors filters (ids, types, projectIds)', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const p1 = 'p1',
      p2 = 'p2'
    const a = await db.addDocument({
      projectId: p1,
      type: 'x',
      name: 'apple',
      src: 's-apple',
      content: '',
    })
    const b = await db.addDocument({
      projectId: p2,
      type: 'y',
      name: 'applet',
      src: 's-applet',
      content: '',
    })

    const resType = await db.searchDocuments({ query: 'apple', types: ['x'], limit: 10 })
    expect(resType.every((r) => r.type === 'x')).toBe(true)

    const resProj = await db.searchDocuments({ query: 'apple', projectIds: [p2], limit: 10 })
    expect(resProj.every((r) => r.projectId === p2)).toBe(true)

    const resIds = await db.searchDocuments({ query: 'apple', ids: [a.id], limit: 10 })
    expect(resIds.map((r) => r.id)).toEqual([a.id])
  })

  it('OR splitting: any token can match name/src', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'first', src: 's-first', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'second', src: 'beta-file', content: '' })

    const res = await db.searchDocuments({
      query: 'alpha beta',
      projectIds: [projectId],
      limit: 10,
    })
    const names = res.map((r) => r.name)
    expect(names).toContain('second') // matched via src token 'beta'
  })
})
