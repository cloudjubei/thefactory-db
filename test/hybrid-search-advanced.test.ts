import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { readSql } from '../src/utils'
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
      const words = (text || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').split(/\s+/).filter(Boolean)
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
        // Skip binary likely files by extension
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
          const [projectId, type, content, src, embeddingLit, metadata] = args as [string, string, string, string, string, any]
          const id = String(seq++)
          const createdAt = nowStr()
          const updatedAt = createdAt
          docs.push({ id, projectId, type, content: content ?? '', src, createdAt, updatedAt, metadata, embedding: parseVectorLiteral(embeddingLit) })
          return {
            rows: [
              {
                id,
                projectId,
                type,
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
          return { rows: d ? [{ ...d, createdAt: d.createdAt, updatedAt: d.updatedAt, metadata: d.metadata }] : [] }
        }
        case 'getDocumentBySrc': {
          const [src] = args as [string]
          const d = docs.find((x) => x.src === src)
          return { rows: d ? [{ ...d, createdAt: d.createdAt, updatedAt: d.updatedAt, metadata: d.metadata }] : [] }
        }
        case 'updateDocument': {
          const [id, typePatch, contentPatch, srcPatch, embeddingLit, metadataPatch] = args as [string, string | null, string | null, string | null, string | null, any]
          const d = docs.find((x) => x.id === id)
          if (!d) return { rows: [] }
          if (typePatch !== null) d.type = typePatch
          if (contentPatch !== null) d.content = contentPatch
          if (srcPatch !== null) d.src = srcPatch
          if (embeddingLit !== null) d.embedding = parseVectorLiteral(embeddingLit)
          if (metadataPatch !== null) d.metadata = metadataPatch
          d.updatedAt = nowStr()
          return { rows: [{ id: d.id, projectId: d.projectId, type: d.type, content: d.content, src: d.src, createdAt: d.createdAt, updatedAt: d.updatedAt, metadata: d.metadata }] }
        }
        case 'deleteDocument': {
          const [id] = args as [string]
          const before = docs.length
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
            if (filter.projectIds) filtered = filtered.filter((d) => filter.projectIds.includes(d.projectId))
          }
          filtered.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
          return { rows: filtered.slice(0, limit).map((d) => ({ id: d.id, projectId: d.projectId, type: d.type, content: d.content, src: d.src, createdAt: d.createdAt, updatedAt: d.updatedAt, metadata: d.metadata })) }
        }
        case 'searchDocumentsQuery': {
          const [queryText, qvecLit, limitRaw, filterJson, textWeight, semWeight] = args as [string, string, number, string, number, number]
          const qvec = parseVectorLiteral(qvecLit)
          const limit = Math.max(1, Math.min(1000, limitRaw ?? 20))
          let filtered = docs.slice()
          const filter = filterJson ? JSON.parse(filterJson) : {}
          if (filter.ids) filtered = filtered.filter((d) => filter.ids.includes(d.id))
          if (filter.types) filtered = filtered.filter((d) => filter.types.includes(d.type))
          if (filter.projectIds) filtered = filtered.filter((d) => filter.projectIds.includes(d.projectId))

          const q = (queryText || '').toLowerCase()
          function keywordScore(d: Doc): number {
            const contentHas = d.content.toLowerCase().includes(q)
            const srcHas = d.src.toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').includes(q)
            // approximate SQL: 0.5 content + 0.5 src
            return (contentHas ? 0.5 : 0) + (srcHas ? 0.5 : 0)
          }

          const scored = filtered.map((d) => {
            const ks = keywordScore(d)
            const vs = d.embedding.length && qvec.length ? cosine(d.embedding, qvec) : 0
            const total = (textWeight ?? 0.5) * ks + (semWeight ?? 0.5) * vs
            return {
              id: d.id,
              projectId: d.projectId,
              type: d.type,
              content: d.content,
              src: d.src,
              createdAt: d.createdAt,
              updatedAt: d.updatedAt,
              metadata: d.metadata ?? null,
              textScore: ks,
              vecScore: vs,
              totalScore: total,
            }
          })
          scored.sort((a, b) => b.totalScore - a.totalScore)
          return { rows: scored.slice(0, limit) }
        }
        default:
          // for entities or others not used here, return empty
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
vi.mock('../src/utils')

describe('Advanced Hybrid Search', () => {
  const mockDb = createMockDb()
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const testProvider = createTestEmbeddingProvider()

  beforeEach(() => {
    vi.clearAllMocks()
    ;(openPostgres as unknown as any).mockResolvedValue(mockDb)
    ;(createLogger as unknown as any).mockReturnValue(mockLogger)
    ;(createLocalEmbeddingProvider as unknown as any).mockResolvedValue(testProvider)
    // Return SQL name so our mock can route
    ;(readSql as unknown as any).mockImplementation((name: string) => name)
  })

  afterAll(async () => {
    await mockDb.end()
  })

  it('Non-code docs: title-only vs content-only vs semantic-only across weights', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const projectId = 'proj-adv'

    // D1: content-only match for query 'car'
    const d1 = await db.addDocument({ projectId, type: 'note', src: 'notes/a.txt', content: 'This document talks about car and engine.' })
    // D2: title-only match (src contains 'Car'), content does not include 'car'
    const d2 = await db.addDocument({ projectId, type: 'note', src: 'notes/Car-Notes.txt', content: 'This note is about vehicles and engines.' })
    // D3: semantic-only (content mentions automobile but not car); src does not include car
    const d3 = await db.addDocument({ projectId, type: 'note', src: 'notes/auto.txt', content: 'This document is about automobile and engine.' })

    const weights = [0, 0.2, 0.5, 0.8, 1]

    const resultsByW = await Promise.all(
      weights.map((w) => db.searchDocuments({ query: 'car', projectIds: [projectId], textWeight: w, limit: 10 }))
    )

    // Helper to find position in result set
    function pos(res: any[], id: string) {
      const i = res.findIndex((r) => r.id === id)
      return i < 0 ? 999 : i
    }

    // Expectations:
    // - D1 (content includes 'car') should consistently rank very high for all weights
    resultsByW.forEach((res, idx) => {
      expect(res.length).toBeGreaterThanOrEqual(3)
      expect(pos(res, d1.id)).toBeLessThanOrEqual(1) // in top-2
    })

    // - As textWeight increases, the title-only doc (D2) should improve in rank relative to semantic-only (D3)
    const positions = resultsByW.map((res) => ({ pD2: pos(res, d2.id), pD3: pos(res, d3.id) }))
    // At low text weight, semantic-only should be ahead or equal to title-only
    expect(positions[0].pD3).toBeLessThanOrEqual(positions[0].pD2)
    // At high text weight, title-only should be ahead of or equal to semantic-only
    expect(positions[positions.length - 1].pD2).toBeLessThanOrEqual(positions[positions.length - 1].pD3)

    // Spot check extremes
    const res0 = resultsByW[0]
    const res1 = resultsByW[resultsByW.length - 1]
    // w=0 (semantic only): D3 should be near top-2 alongside D1
    expect(pos(res0, d3.id)).toBeLessThanOrEqual(2)
    // w=1 (text only): D2 should be near top-2 alongside D1
    expect(pos(res1, d2.id)).toBeLessThanOrEqual(2)
  })

  it('Project files ingestion: can search across repository files for hybrid-related queries', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const projectId = 'proj-code'
    const root = process.cwd()
    const files = collectProjectFiles(root)

    // Ingest all project files as documents
    for (const rel of files) {
      const full = path.join(root, rel)
      try {
        const content = fs.readFileSync(full, 'utf8')
        await db.addDocument({ projectId, type: path.extname(rel).slice(1) || 'txt', src: rel, content })
      } catch {
        // ignore read errors or binaries
      }
    }

    const weights = [0, 0.2, 0.5, 0.8, 1]

    for (const w of weights) {
      const results = await db.searchDocuments({ query: 'hybrid search', projectIds: [projectId], textWeight: w, limit: 20 })
      // Expect at least one result
      expect(results.length).toBeGreaterThan(0)
      // Expect some of the top results to be from docs/ or src/ where hybrid search is defined
      const topSrcs = results.slice(0, 5).map((r) => r.src)
      expect(topSrcs.some((s) => s.includes('docs/') || s.includes('src/'))).toBe(true)
    }
  })
})
