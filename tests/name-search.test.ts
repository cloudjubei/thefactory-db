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

          // Input-only normalization
          const raw = (queryText || '').trim().toLowerCase()
          const fullRaw = raw
          const lastSeg = raw.replace(/^.*[\\\/]/, '')
          const baseRaw = lastSeg.replace(/\.[^.]+$/, '')
          const normalized = raw.replace(/[-._/]+/g, ' ').replace(/[^a-z0-9 ]+/g, '')
          const tokens = normalized.split(/\s+/).filter(Boolean)

          function scoreStr(target: string, needle: string | undefined): number {
            if (!needle) return 0
            if (target === needle) return 3
            if (target.startsWith(needle)) return 2
            if (target.includes(needle)) return 1
            return 0
          }

          const rows = filtered
            .map((d) => {
              const lname = (d.name || '').toLowerCase()
              const lsrc = (d.src || '').toLowerCase()

              let tokenName = 0,
                tokenSrc = 0
              for (const t of tokens) {
                tokenName = Math.max(tokenName, scoreStr(lname, t))
                tokenSrc = Math.max(tokenSrc, scoreStr(lsrc, t))
              }

              const fullName = scoreStr(lname, fullRaw)
              const fullSrc = scoreStr(lsrc, fullRaw)
              const baseName = scoreStr(lname, baseRaw)
              const baseSrc = scoreStr(lsrc, baseRaw)

              const tokenStrength = Math.max(tokenName, tokenSrc)
              const fullRawStrength = Math.max(fullName, fullSrc)
              const baseStrength = Math.max(baseName, baseSrc)

              const nameBest = Math.max(tokenName, fullName, baseName)
              const srcBest = Math.max(tokenSrc, fullSrc, baseSrc)

              return {
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
                totalScore: Math.max(nameBest, srcBest),
                _fullRawStrength: fullRawStrength,
                _tokenStrength: tokenStrength,
                _baseStrength: baseStrength,
                _nameBest: nameBest,
                _srcBest: srcBest,
                _nameLen: d.name.length,
              }
            })
            .filter((r) => r.totalScore > 0)

          rows.sort((a, b) => {
            if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore
            const aFull = a._fullRawStrength > 0 ? 1 : 0
            const bFull = b._fullRawStrength > 0 ? 1 : 0
            if (bFull !== aFull) return bFull - aFull
            const aTok = a._tokenStrength > 0 ? 1 : 0
            const bTok = b._tokenStrength > 0 ? 1 : 0
            if (bTok !== aTok) return bTok - aTok
            const aBase = a._baseStrength > 0 ? 1 : 0
            const bBase = b._baseStrength > 0 ? 1 : 0
            if (bBase !== aBase) return bBase - aBase
            const aPrefer = a._nameBest >= a._srcBest ? 1 : 0
            const bPrefer = b._nameBest >= b._srcBest ? 1 : 0
            if (bPrefer !== aPrefer) return bPrefer - aPrefer
            if (a._nameLen !== b._nameLen) return a._nameLen - b._nameLen
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
    // Two equality-strength docs; prefer name-match over src-match within tier
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
    await db.addDocument({
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

  it('pre-processing removes standalone OR (case-insensitive) and behaves like space', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'first', src: 's-first', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'second', src: 'beta-file', content: '' })

    const res = await db.searchDocuments({
      query: 'alpha OR beta',
      projectIds: [projectId],
      limit: 10,
    })
    expect(res.map((r) => r.name)).toContain('second')
  })

  it('pre-processing handles multiple OR occurrences (case-insensitive)', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'first', src: 's-first', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'second', src: 'beta-file', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'third', src: 'gamma-file', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'fourth', src: 'delta-file', content: '' })

    const res = await db.searchDocuments({
      query: 'alpha or beta OR gamma oR delta',
      projectIds: [projectId],
      limit: 10,
    })
    const names = res.map((r) => r.name)
    expect(names).toContain('second')
    expect(names).toContain('third')
    expect(names).toContain('fourth')
  })

  it('ignores extensions in query and prefers shorter basename within same tier', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'FileTools.ts', src: 'src/FileTools.ts', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'FileTools.test.ts', src: 'src/FileTools.test.ts', content: '' })

    // With extension in query
    const resExt = await db.searchDocuments({ query: 'FileTools.ts', projectIds: [projectId], limit: 10 })
    expect(resExt.map((r) => r.name)).toEqual(['FileTools.ts', 'FileTools.test.ts'])

    // Without extension in query
    const resNoExt = await db.searchDocuments({ query: 'FileTools', projectIds: [projectId], limit: 10 })
    expect(resNoExt.map((r) => r.name)).toEqual(['FileTools.ts', 'FileTools.test.ts'])
  })

  it('prefers full_raw equality on name over token/base matches within the same strength tier', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    // Exact full_raw match on name
    await db.addDocument({ projectId, type: 't', name: 'FileTools.ts', src: 's1', content: '' })
    // Token-only equality (name is exactly the token 'filetools')
    await db.addDocument({ projectId, type: 't', name: 'filetools', src: 's2', content: '' })

    const res = await db.searchDocuments({ query: 'FileTools.ts', projectIds: [projectId], limit: 10 })
    expect(res.map((r) => r.name).slice(0, 2)).toEqual(['FileTools.ts', 'filetools'])
  })

  it('is case-insensitive for full_raw and tokens', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'FileTools.ts', src: 'src/utils/FileTools.ts', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'FileTools.test.ts', src: 'src/utils/FileTools.test.ts', content: '' })

    const res = await db.searchDocuments({ query: 'FILEtools.TS', projectIds: [projectId], limit: 10 })
    expect(res.map((r) => r.name).slice(0, 2)).toEqual(['FileTools.ts', 'FileTools.test.ts'])
  })

  it('full path query prefers exact src equality over token/base matches', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'Zzz.ts', src: 'pkg/module/FileTools.ts', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'FileTools.ts', src: 'some/other/path.ts', content: '' })

    const res = await db.searchDocuments({ query: 'pkg/module/FileTools.ts', projectIds: [projectId], limit: 10 })
    expect(res[0]?.src).toBe('pkg/module/FileTools.ts')
  })

  it('handles multi-dot filenames: exact and base-only queries', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    await db.addDocument({ projectId, type: 't', name: 'something.service.test.ts', src: 'src/something.service.test.ts', content: '' })
    await db.addDocument({ projectId, type: 't', name: 'something.service.ts', src: 'src/something.service.ts', content: '' })

    const exact = await db.searchDocuments({ query: 'something.service.test.ts', projectIds: [projectId], limit: 10 })
    expect(exact[0]?.name).toBe('something.service.test.ts')

    const base = await db.searchDocuments({ query: 'something.service.test', projectIds: [projectId], limit: 10 })
    expect(base[0]?.name).toBe('something.service.test.ts')

    const mixed = await db.searchDocuments({ query: 'Something.Service.Test.TS', projectIds: [projectId], limit: 10 })
    expect(mixed[0]?.name).toBe('something.service.test.ts')
  })

  it('token presence breaks ties over base-only matches within the same strength tier', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const projectId = 'p'
    // Query: 'zzz.file' -> tokens: ['zzz', 'file'], base_raw: 'zzz'
    // Doc A: token-only contains 'file' in name
    await db.addDocument({ projectId, type: 't', name: 'a-file-here', src: 'sA', content: '' })
    // Doc B: base-only contains 'zzz' in name (no 'file' token)
    await db.addDocument({ projectId, type: 't', name: 'zzz-other', src: 'sB', content: '' })

    const res = await db.searchDocuments({ query: 'zzz.file', projectIds: [projectId], limit: 10 })
    const names = res.map((r) => r.name)
    // Both get totalScore 1 and both have token presence; with current tie-breakers, base presence is considered next
    expect(names.indexOf('a-file-here')).toBeGreaterThan(names.indexOf('zzz-other'))
  })
})
