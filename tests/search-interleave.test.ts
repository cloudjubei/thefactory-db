import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')
vi.mock('../src/utils', async () => {
  const actual = await vi.importActual<any>('../src/utils')
  return {
    ...actual,
    // Every SQL key resolves to the same placeholder string in this suite
    SQL: new Proxy({}, { get: () => 'FAKE_SQL' }),
  }
})

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
    const name = [{ id: 'n1' }, { id: 'shared' }, { id: 'n2' }]

    mockDb.query.mockImplementation(async (_sql: string, args: any[]) => {
      // namePromise uses [query, limit, filterJson]
      if (typeof args?.[1] === 'number') return { rows: name }
      // hybridPromise uses [query, qvec, limit, ...]
      return { rows: hybrid }
    })

    const out = await db.searchDocuments({ projectIds: ['p'], query: 'x', limit: 5 })
    expect(out.map((r: any) => r.id)).toEqual(['n1', 'h1', 'shared', 'n2', 'h2'])
  })

  it('handles early exhaustion when one list runs out', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    const hybrid = [{ id: 'h1' }, { id: 'h2' }]
    const name = [{ id: 'n1' }]

    mockDb.query.mockImplementation(async (_sql: string, args: any[]) => {
      if (typeof args?.[1] === 'number') return { rows: name }
      return { rows: hybrid }
    })

    const out = await db.searchDocuments({ projectIds: ['p'], query: 'x', limit: 5 })
    expect(out.map((r: any) => r.id)).toEqual(['n1', 'h1', 'h2'])
  })

  it('is deterministic and respects final API limit', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    const hybrid = [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }]
    const name = [{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]

    mockDb.query.mockImplementation(async (_sql: string, args: any[]) => {
      if (typeof args?.[1] === 'number') return { rows: name }
      return { rows: hybrid }
    })

    const out = await db.searchDocuments({ projectIds: ['p'], query: 'x', limit: 4 })
    expect(out.map((r: any) => r.id)).toEqual(['n1', 'h1', 'n2', 'h2'])
  })
})
