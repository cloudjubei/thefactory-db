import { describe, it, expect, vi, beforeEach } from 'vitest'

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (!na || !nb) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function parseVectorLiteral(lit: string): Float32Array {
  const s = (lit || '').trim()
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  if (!inner.trim()) return new Float32Array([])
  return new Float32Array(inner.split(',').map((x) => Number(x.trim())))
}

function createTestEmbeddingProvider() {
  // Very small deterministic 'semantic' behaviour for synonyms used in tests.
  // We map tokens to a 3D vector so cosine() gives meaningful scores.
  const tokenVec: Record<string, [number, number, number]> = {
    car: [1, 0, 0],
    automobile: [1, 0, 0],
    engine: [0, 1, 0],
    motor: [0, 1, 0],
    maintenance: [0, 0, 1],
    upkeep: [0, 0, 1],
  }

  function embed(text: string): number[] {
    const toks = (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)

    let v: [number, number, number] = [0, 0, 0]
    for (const t of toks) {
      const tv = tokenVec[t]
      if (!tv) continue
      v = [v[0] + tv[0], v[1] + tv[1], v[2] + tv[2]]
    }
    return v
  }

  return { embed }
}

// This allows us to test ranking/weights logic without a real postgres.
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
      const normalized = (sql || '').trim()

      switch (normalized) {
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

        case 'searchDocumentsQuery': {
          // Signature in src/client/documents.ts: db.query(SQL.searchDocumentsQuery, [...])
          // [query, qvec, limit, filterJson, nameWeight, textWeight, keywordWeight, semWeight, rrfK]
          const [queryText, qvecLit, limitRaw, _filterJson, _nameW, textW, keywordW, semW] = args as [
            string,
            string,
            number,
            string,
            number,
            number,
            number,
            number,
          ]
          const limit = typeof limitRaw === 'number' ? limitRaw : 10
          const qvec = parseVectorLiteral(qvecLit)

          const qTokens = (queryText || '')
            .toLowerCase()
            .replace(/[^a-z0-9\s]+/g, ' ')
            .split(/\s+/)
            .filter(Boolean)

          function keywordScore(doc: Doc): number {
            const docText = `${doc.name} ${doc.content}`.toLowerCase()
            // Require ALL query tokens to be present for 'keyword list search'.
            if (qTokens.length === 0) return 0
            const allPresent = qTokens.every((t) => docText.includes(t))
            return allPresent ? 1 : 0
          }

          function semanticScore(doc: Doc): number {
            if (qvec.length === 0 || doc.embedding.length === 0) return 0
            return cosine(qvec, doc.embedding)
          }

          const scored = docs.map((d) => {
            const ks = keywordScore(d)
            const vs = semanticScore(d)
            const total = ks * (textW + keywordW) + vs * semW
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

        case 'searchDocumentsByName': {
          // Not used in these advanced tests; return empty results.
          return { rows: [] }
        }

        default: {
          return { rows: [] }
        }
      }
    }),
    end: vi.fn(async () => {}),
  }

  return client
}

// ------------------------------
// Local module mocks (no setupUnitTestMocks)
// ------------------------------
let mockDbClient: ReturnType<typeof createMockDb>
let mockEmbeddingProvider: { embed: any; close: any }
let mockLogger: { debug: any; info: any; warn: any; error: any }

vi.mock('../../src/sql', () => ({
  SQL: {
    insertDocument: 'insertDocument',
    searchDocumentsQuery: 'searchDocumentsQuery',
    searchDocumentsByName: 'searchDocumentsByName',
  },
}))

vi.mock('../../src/connection', () => ({
  openPostgres: vi.fn(async () => mockDbClient),
}))

vi.mock('../../src/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}))

vi.mock('../../src/utils/embeddings', () => ({
  createLocalEmbeddingProvider: vi.fn(async () => mockEmbeddingProvider),
}))

// Import SUT after mocks
import { openDatabase } from '../../src/index'

describe('Documents.searchDocuments (advanced)', () => {
  const testProvider = createTestEmbeddingProvider()

  beforeEach(() => {
    vi.clearAllMocks()

    mockDbClient = createMockDb()

    mockLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    mockEmbeddingProvider = {
      embed: vi.fn((t: string) => testProvider.embed(t)),
      close: vi.fn(),
    }
  })

  it('merges results from hybrid + name search into a single list (no duplicates) and uses name results first', async () => {
    // Override DB query to return controlled responses so we can validate merge/dedupe behaviour.
    const db = await openDatabase({ connectionString: 'x' })

    const baseDoc = {
      projectId: 'p',
      type: 't',
      name: 'n',
      content: 'c',
      src: 's',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: null as any,
    }

    const hybrid = [
      { id: 'h1', ...baseDoc, textScore: 0.1, keywordScore: 0.2, vecScore: 0.3, totalScore: 0.6 },
      { id: 'h2', ...baseDoc, textScore: 0.1, keywordScore: 0.2, vecScore: 0.3, totalScore: 0.6 },
    ]
    const name = [{ id: 'n1', ...baseDoc }]

    mockDbClient.query.mockImplementation(async (_sql: string, args?: any[]) => {
      if (typeof args?.[1] === 'number' && typeof args?.[2] === 'string') return { rows: name }
      return { rows: hybrid }
    })

    const out = await db.searchDocuments({ projectIds: ['p'], query: 'x', limit: 5 })
    expect(out.map((r: any) => r.id)).toEqual(['n1', 'h1', 'h2'])
  })

  it('is deterministic and respects final API limit', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    const baseDoc = {
      projectId: 'p',
      type: 't',
      name: 'n',
      content: 'c',
      src: 's',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: null as any,
    }

    const hybrid = [
      { id: 'h1', ...baseDoc, textScore: 0.1, keywordScore: 0.2, vecScore: 0.3, totalScore: 0.6 },
      { id: 'h2', ...baseDoc, textScore: 0.1, keywordScore: 0.2, vecScore: 0.3, totalScore: 0.6 },
      { id: 'h3', ...baseDoc, textScore: 0.1, keywordScore: 0.2, vecScore: 0.3, totalScore: 0.6 },
    ]
    const name = [{ id: 'n1', ...baseDoc }, { id: 'n2', ...baseDoc }, { id: 'n3', ...baseDoc }]

    mockDbClient.query.mockImplementation(async (_sql: string, args?: any[]) => {
      if (typeof args?.[1] === 'number' && typeof args?.[2] === 'string') return { rows: name }
      return { rows: hybrid }
    })

    const out = await db.searchDocuments({ projectIds: ['p'], query: 'x', limit: 4 })
    expect(out.map((r: any) => r.id)).toEqual(['n1', 'h1', 'n2', 'h2'])
  })

  it('keyword list search: matches documents based on full keyword presence when textWeight=1', async () => {
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

    const resultIdsText = resultsText.map((r: any) => r.id)

    expect(resultIdsText).toContain(d1.id)
    expect(resultIdsText).toContain(d2.id)
    expect(resultIdsText).toContain(d3.id)
    expect(resultIdsText).not.toContain(d4.id)
    expect(resultIdsText).not.toContain(d5.id)
    expect(resultIdsText).not.toContain(d6.id)
    expect(resultsText.length).toBe(3)
  })

  it('semantic-only search: can return synonym-like matches when textWeight=0', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    const projectId = 'proj-sem'

    await db.addDocument({
      projectId,
      type: 'note',
      name: 'nope',
      src: 'nope.txt',
      content: 'This is about gardening',
    })

    const dSyn = await db.addDocument({
      projectId,
      type: 'note',
      name: 'semantic',
      src: 'semantic.txt',
      content: 'automobile engine',
    })

    const resultsSemantic = await db.searchDocuments({
      query: 'car engine',
      projectIds: [projectId],
      textWeight: 0,
      limit: 10,
    })

    const ids = resultsSemantic.map((r: any) => r.id)
    expect(ids).toContain(dSyn.id)
  })
})
