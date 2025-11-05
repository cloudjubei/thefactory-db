import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')
vi.mock('../src/utils', () => ({
  // Every SQL key resolves to the same placeholder string in this suite
  SQL: new Proxy({}, { get: () => 'FAKE_SQL' }),
}))

describe('searchDocuments interleaving and de-duplication', () => {
  let mockDb: any
  let mockLogger: any
  let mockEmbedding: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    mockEmbedding = { embed: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])) }
    mockDb = { query: vi.fn(), end: vi.fn() }

    vi.mocked(openPostgres).mockResolvedValue(mockDb)
    vi.mocked(createLogger).mockReturnValue(mockLogger)
    vi.mocked(createLocalEmbeddingProvider).mockResolvedValue(mockEmbedding)
  })

  it('alternates between name/src and hybrid results, de-duplicates by id, and caps to limit', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    const hybrid = [{ id: 'h1' }, { id: 'shared' }, { id: 'h2' }, { id: 'h3' }]
    const name = [
      { id: 'n1' },
      { id: 'shared' }, // duplicate with hybrid
      { id: 'n2' },
      { id: 'n3' },
    ]

    // First call is hybrid, second call is name/src in our implementation
    mockDb.query.mockResolvedValueOnce({ rows: hybrid }).mockResolvedValueOnce({ rows: name })

    const results = await db.searchDocuments({ query: 'q', limit: 6 })
    const ids = results.map((r: any) => r.id)
    // Interleaving starting with name: n1, h1, n2, shared (ONLY ONCE), h2, n3 - skips the last: h3
    expect(ids).toEqual(['n1', 'h1', 'shared', 'n2', 'h2', 'n3'])
  })

  it('handles early exhaustion when one list runs out', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const hybrid = [{ id: 'h1' }]
    const name = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]

    mockDb.query
      .mockResolvedValueOnce({ rows: hybrid }) // hybrid
      .mockResolvedValueOnce({ rows: name }) // name

    const results = await db.searchDocuments({ query: 'q', limit: 5 })
    const ids = results.map((r: any) => r.id)
    expect(ids).toEqual(['n1', 'h1', 'n2', 'n3'])
  })

  it('is deterministic and respects final API limit', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    const hybrid = Array.from({ length: 10 }, (_, i) => ({ id: `h${i}` }))
    const name = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}` }))
    mockDb.query
      .mockResolvedValueOnce({ rows: hybrid })
      .mockResolvedValueOnce({ rows: name })
      .mockResolvedValueOnce({ rows: hybrid })
      .mockResolvedValueOnce({ rows: name })

    const res10 = await db.searchDocuments({ query: 'q', limit: 10 })
    const res10b = await db.searchDocuments({ query: 'q', limit: 10 })

    expect(res10.map((r: any) => r.id)).toEqual(res10b.map((r: any) => r.id))
    expect(res10.length).toBe(10)
  })
})
