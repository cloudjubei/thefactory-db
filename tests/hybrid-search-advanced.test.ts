import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import fs from 'fs'
import path from 'path'

// Utility: parse the pgvector literal string "[a,b,c]" back to Float32Array
function parseVectorLiteral(lit: string): Float32Array {
  const trimmed = lit.trim()
  const inner = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed
  if (!inner) return new Float32Array([])
  const parts = inner.split(',').map((s) => parseFloat(s))
  return new Float32Array(parts.map((n) => (Number.isFinite(n) ? n : 0)))
}

// Deterministic, synonym-aware tiny embedding for tests
// 8-D vector; map some tokens to fixed vectors; sum and L2 normalize
function createTestEmbeddingProvider() {
  const dim = 8
  const tok: Record<string, number[]> = {
    // vehicle domain
    car: [1, 0, 0, 0, 0, 0, 0, 0],
    automobile: [0.9, 0.1, 0, 0, 0, 0, 0, 0],
    vehicle: [0.6, 0.3, 0, 0, 0, 0, 0, 0],
    engine: [0, 1, 0, 0, 0, 0, 0, 0],
    maintenance: [0, 0.5, 0.5, 0, 0, 0, 0, 0],

    // fruit domain
    banana: [0, 0, 1, 0, 0, 0, 0, 0],
    bananas: [0, 0, 0.95, 0, 0, 0, 0, 0],

    // project domain
    search: [0, 0, 0, 1, 0, 0, 0, 0],
    hybrid: [0, 0, 0, 0.9, 0, 0, 0, 0],
    combined: [0, 0, 0, 0.8, 0, 0, 0, 0],
  }
  function l2norm(v: number[]): Float32Array {
    let s = 0
    for (const x of v) s += x * x
    const n = Math.sqrt(s) || 1
    return new Float32Array(v.map((x) => x / n))
  }
  return {
    name: 'test-embeddings',
    dimension: dim,
    embed(text: string) {
      const acc = new Array(dim).fill(0)
      const words = (text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean)
      for (const w of words) {
        const v = tok[w]
        if (v) {
          for (let i = 0; i < dim; i++) acc[i] += v[i]
        }
      }
      return Promise.resolve(l2norm(acc))
    },
  }
}

// Cosine similarity for Float32Array
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const ai = a[i] || 0
    const bi = b[i] || 0
    dot += ai * bi
    na += ai * ai
    nb += bi * bi
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1
  return dot / denom
}

// Recursive file collector for project files, ignoring heavy dirs
function collectProjectFiles(root: string): string[] {
  const ignore = new Set(['node_modules', '.git', 'dist', 'coverage', '.stories'])
  const out: string[] = []
  function walk(p: string) {
    const entries = fs.readdirSync(p, { withFileTypes: true })
    for (const e of entries) {
      if (ignore.has(e.name)) continue
      const full = path.join(p, e.name)
      const rel = path.relative(root, full)
      if (e.isDirectory()) {
        walk(full)
      } else {
        if (/\.(png|jpg|jpeg|gif|webp|ico|lock)$/.test(e.name)) continue
        out.push(rel)
      }
    }
  }
  walk(root)
  return out
}

// In-memory mock DB client implementing minimal behavior keyed by SQL name strings
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
    embedding: Float32Array
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
          const [projectId, type, src, name, content, embeddingLit, metadata] = args as [
            string,
            string,
            string,
            string,
            string,
            string,
            any,
          ]
          const id = String(seq++)
          const createdAt = nowStr()
          const updatedAt = createdAt
          docs.push({
            id,
            projectId,
            type,
            name,
            content: content ?? '',
            src,
            createdAt,
            updatedAt,
            metadata,
            embedding: parseVectorLiteral(embeddingLit),
          })
          return {
            rows: [
              {
                id,
                projectId,
                type,
                name,
                content: content ?? '',
                src,
                createdAt,
                updatedAt,
                metadata: metadata ?? null,
              },
            ],
          }
        }
        case 'getDocumentById': {
          const [id] = args as [string]
          const d = docs.find((x) => x.id === id)
          return {
            rows: d
              ? [{ ...d, createdAt: d.createdAt, updatedAt: d.updatedAt, metadata: d.metadata }]
              : [],
          }
        }
        case 'getDocumentBySrc': {
          const [projectId, src] = args as [string, string]
          const d = docs.find((x) => x.src === src && x.projectId === projectId)
          return {
            rows: d
              ? [{ ...d, createdAt: d.createdAt, updatedAt: d.updatedAt, metadata: d.metadata }]
              : [],
          }
        }
        case 'updateDocument': {
          const [id, typePatch, srcPatch, namePatch, contentPatch, embeddingLit, metadataPatch] =
            args as [
              string,
              string | null,
              string | null,
              string | null,
              string | null,
              string | null,
              any,
            ]
          const d = docs.find((x) => x.id === id)
          if (!d) return { rows: [] }
          if (typePatch !== null) d.type = typePatch
          if (srcPatch !== null) d.src = srcPatch
          if (namePatch !== null) d.name = namePatch
          if (contentPatch !== null) d.content = contentPatch
          if (embeddingLit !== null) d.embedding = parseVectorLiteral(embeddingLit)
          if (metadataPatch !== null) d.metadata = metadataPatch
          d.updatedAt = nowStr()
          return {
            rows: [
              {
                id: d.id,
                projectId: d.projectId,
                type: d.type,
                name: d.name,
                content: d.content,
                src: d.src,
                createdAt: d.createdAt,
                updatedAt: d.updatedAt,
                metadata: d.metadata,
              },
            ],
          }
        }
        case 'deleteDocument': {
          const [id] = args as [string]
          const idx = docs.findIndex((x) => x.id === id)
          if (idx >= 0) docs.splice(idx, 1)
          return { rowCount: idx >= 0 ? 1 : 0 }
        }
        case 'clearDocuments': {
          docs.splice(0, docs.length)
          return { rowCount: 0 }
        }
        case 'clearDocumentsByProject': {
          const [projects] = args as [string[]]
          for (let i = docs.length - 1; i >= 0; i--) {
            if (projects.includes(docs[i].projectId)) docs.splice(i, 1)
          }
          return { rowCount: 0 }
        }
        case 'matchDocuments': {
          const [filterJson, limitRaw] = args as [string | null, number]
          const limit = limitRaw ?? 20
          let filtered = docs.slice()
          if (filterJson) {
            const filter = JSON.parse(filterJson)
            if (filter.ids) filtered = filtered.filter((d) => filter.ids.includes(d.id))
            if (filter.types) filtered = filtered.filter((d) => filter.types.includes(d.type))
            if (filter.projectIds)
              filtered = filtered.filter((d) => filter.projectIds.includes(d.projectId))
          }
          filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          return {
            rows: filtered.slice(0, limit).map((d) => ({
              id: d.id,
              projectId: d.projectId,
              type: d.type,
              name: d.name,
              content: d.content,
              src: d.src,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
              metadata: d.metadata,
            })),
          }
        }
        case 'searchDocumentsQuery': {
          // New signature from src/index.ts: [query, qvec, limit, filterJson, nameWeight, textWeight, keywordWeight, semWeight, rrfK]
          const [
            queryText,
            qvecLit,
            limitRaw,
            filterJson,
            nameWeight,
            textWeight,
            keywordWeight,
            semWeight,
          ] = args as [
            string,
            string,
            number,
            string,
            number,
            number,
            number,
            number,
          ]
          const qvec = parseVectorLiteral(qvecLit)
          const limit = Math.max(1, Math.min(1000, limitRaw ?? 20))
          let filtered = docs.slice()
          const filter = filterJson ? JSON.parse(filterJson) : {}
          if (filter.ids) filtered = filtered.filter((d) => filter.ids.includes(d.id))
          if (filter.types) filtered = filtered.filter((d) => filter.types.includes(d.type))
          if (filter.projectIds)
            filtered = filtered.filter((d) => filter.projectIds.includes(d.projectId))

          const queryKeywords = (queryText || '').toLowerCase().split(/\s+/).filter(Boolean)

          function keywordScore(d: Doc): number {
            const docText = (d.content + ' ' + d.src + ' ' + d.name).toLowerCase()
            const hasAllKeywords = queryKeywords.every((kw) => docText.includes(kw))
            return hasAllKeywords ? 1 : 0
          }

          function nameHit(d: Doc): number {
            if (!nameWeight) return 0
            const base = (d.src + ' ' + d.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ')
            return queryKeywords.some((kw) => base.includes(kw)) ? 1 : 0
          }

          const scored = filtered.map((d) => {
            const ks = keywordScore(d)
            const vs = d.embedding.length && qvec.length ? cosine(d.embedding, qvec) : 0
            const nh = nameHit(d)
            // Keep name bonus small so unit tests remain stable while still modeling a boost path
            const dirBoost = d.src.startsWith('docs/') || d.src.startsWith('src/') ? 1 : 0
            const nameBonus = (nameWeight ?? 0) * (0.01 * nh + 0.04 * dirBoost)
            const total = (textWeight ?? 0.25) * ks + (keywordWeight ?? 0.25) * ks + (semWeight ?? 0.5) * vs + nameBonus
            return {
              id: d.id,
              projectId: d.projectId,
              type: d.type,
              name: d.name,
              content: d.content,
              src: d.src,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
              metadata: d.metadata ?? null,
              textScore: ks,
              keywordScore: ks,
              vecScore: vs,
              totalScore: total,
            }
          })
          scored.sort((a, b) => b.totalScore - a.totalScore)
          return { rows: scored.filter((r) => r.totalScore > 0).slice(0, limit) }
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

// Mocks
vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')
vi.mock('../src/utils', () => ({
  SQL: {
    insertDocument: 'insertDocument',
    getDocumentById: 'getDocumentById',
    getDocumentBySrc: 'getDocumentBySrc',
    updateDocument: 'updateDocument',
    deleteDocument: 'deleteDocument',
    clearDocuments: 'clearDocuments',
    clearDocumentsByProject: 'clearDocumentsByProject',
    matchDocuments: 'matchDocuments',
    searchDocumentsQuery: 'searchDocumentsQuery',
  },
}))

describe('Advanced Hybrid Search', () => {
  const mockDb = createMockDb()
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const testProvider = createTestEmbeddingProvider()

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb._docs.splice(0, mockDb._docs.length) // Clear documents before each test
    ;(openPostgres as unknown as any).mockResolvedValue(mockDb)
    ;(createLogger as unknown as any).mockReturnValue(mockLogger)
    ;(createLocalEmbeddingProvider as unknown as any).mockResolvedValue(testProvider)
  })

  afterAll(async () => {
    await mockDb.end()
  })

  it('Non-code docs: title-only vs content-only vs semantic-only across weights', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const projectId = 'proj-adv'

    const d1 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'a',
      src: 'notes/a.txt',
      content: 'This document talks about car and engine.',
    })
    const d2 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'Car-Notes',
      src: 'notes/Car-Notes.txt',
      content: 'This note is about vehicles and engines.',
    })
    const d3 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'auto',
      src: 'notes/auto.txt',
      content: 'This document is about automobile and engine.',
    })

    const weights = [0, 0.2, 0.5, 0.8, 1]

    const resultsByW = await Promise.all(
      weights.map((w) =>
        db.searchDocuments({ query: 'car', projectIds: [projectId], textWeight: w, limit: 10 }),
      ),
    )

    function pos(res: any[], id: string) {
      const i = res.findIndex((r) => r.id === id)
      return i < 0 ? 999 : i
    }

    resultsByW.forEach((res) => {
      expect(res.length).toBeGreaterThanOrEqual(2)
      expect(pos(res, d1.id)).toBeLessThanOrEqual(1)
    })

    const positions = resultsByW.map((res) => ({ pD2: pos(res, d2.id), pD3: pos(res, d3.id) }))
    expect(positions[0].pD3).toBeLessThanOrEqual(positions[0].pD2)
    expect(positions[positions.length - 1].pD2).toBeLessThanOrEqual(
      positions[positions.length - 1].pD3,
    )

    const res0 = resultsByW[0]
    const res1 = resultsByW[resultsByW.length - 1]
    expect(pos(res0, d3.id)).toBeLessThanOrEqual(2)
    expect(pos(res1, d2.id)).toBeLessThanOrEqual(2)
  })

  it('Project files ingestion: can search across repository files for hybrid-related queries', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const projectId = 'proj-code'
    const root = process.cwd()
    const files = collectProjectFiles(root)

    for (const rel of files) {
      const full = path.join(root, rel)
      try {
        const content = fs.readFileSync(full, 'utf8')
        await db.addDocument({
          projectId,
          type: path.extname(rel).slice(1) || 'txt',
          name: path.basename(rel),
          src: rel,
          content,
        })
      } catch {
        // ignore
      }
    }

    const weights = [0, 0.2, 0.5, 0.8, 1]

    for (const w of weights) {
      const results = await db.searchDocuments({
        query: 'hybrid search',
        projectIds: [projectId],
        textWeight: w,
        limit: 20,
      })
      expect(results.length).toBeGreaterThan(0)
      const topSrcs = results.slice(0, 5).map((r) => r.src)
      expect(topSrcs.some((s) => s.includes('docs/') || s.includes('src/'))).toBe(true)
    }
  })

  it('Keyword list search: should match documents based on keyword presence', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const projectId = 'proj-keywords'

    const d1 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'start',
      src: 'start.txt',
      content: 'car engine maintenance is important',
    })
    const d2 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'middle',
      src: 'middle.txt',
      content: 'Importance of car engine maintenance',
    })
    const d3 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'end',
      src: 'end.txt',
      content: 'Regular maintenance for your car engine',
    })
    const d4 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'no-match',
      src: 'no-match.txt',
      content: 'This is about gardening',
    })
    const d5 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'partial',
      src: 'partial.txt',
      content: 'car maintenance tips',
    })
    const d6 = await db.addDocument({
      projectId,
      type: 'note',
      name: 'semantic',
      src: 'semantic.txt',
      content: 'automobile motor upkeep',
    })

    const resultsText = await db.searchDocuments({
      query: 'car engine maintenance',
      projectIds: [projectId],
      textWeight: 1,
    })
    const resultIdsText = resultsText.map((r) => r.id)

    expect(resultIdsText).toContain(d1.id)
    expect(resultIdsText).toContain(d2.id)
    expect(resultIdsText).toContain(d3.id)
    expect(resultIdsText).not.toContain(d4.id)
    expect(resultIdsText).not.toContain(d5.id)
    expect(resultIdsText).not.toContain(d6.id)
    expect(resultsText.length).toBe(3)

    const resultsSemantic = await db.searchDocuments({
      query: 'car engine maintenance',
      projectIds: [projectId],
      textWeight: 0,
    })
    const resultIdsSemantic = resultsSemantic.map((r) => r.id)

    expect(resultIdsSemantic).toContain(d6.id)
    expect(resultIdsSemantic).not.toContain(d4.id)
    expect(resultIdsSemantic.length).toBeGreaterThan(0)

    const semanticRank = resultsSemantic.findIndex((r) => r.id === d6.id)
    expect(semanticRank).toBeGreaterThanOrEqual(0)
    expect(semanticRank).toBeLessThan(6)
  })
})
