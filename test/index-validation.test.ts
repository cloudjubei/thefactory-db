import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { readSql } from '../src/utils'

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')
vi.mock('../src/utils')

/**
 * Tests focusing on validation and edge cases in the public API
 */
describe('TheFactoryDb validation and edges', () => {
  let mockDbClient: any
  let mockLogger: any
  let mockEmbeddingProvider: any

  beforeEach(() => {
    vi.clearAllMocks()

    mockDbClient = {
      query: vi.fn(),
      end: vi.fn(),
    }
    mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    mockEmbeddingProvider = { embed: vi.fn() }

    vi.mocked(openPostgres).mockResolvedValue(mockDbClient)
    vi.mocked(createLogger).mockReturnValue(mockLogger)
    vi.mocked(createLocalEmbeddingProvider).mockResolvedValue(mockEmbeddingProvider)
    vi.mocked(readSql).mockReturnValue('FAKE_SQL')
    mockEmbeddingProvider.embed.mockResolvedValue(new Float32Array([0.1, 0.2, 0.3]))
  })

  it('addDocument rejects invalid input', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    // @ts-expect-error invalid types on purpose
    await expect(db.addDocument({})).rejects.toThrow()
    // invalid content type
    // @ts-expect-error invalid
    await expect(db.addDocument({ projectId: 'p', type: 't', src: 's', content: 123 })).rejects.toThrow()
  })

  it('updateDocument rejects invalid patch', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await expect(db.updateDocument('id', { projectId: 'nope' } as any)).rejects.toThrow()
    await expect(db.updateDocument('id', { content: 123 as any })).rejects.toThrow()
  })

  it('addEntity rejects invalid input', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    // @ts-expect-error
    await expect(db.addEntity({})).rejects.toThrow()
    // content must be object/array
    // @ts-expect-error
    await expect(db.addEntity({ projectId: 'p', type: 't', content: 'x' })).rejects.toThrow()
  })

  it('updateEntity rejects invalid patch', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await expect(db.updateEntity('id', { projectId: 'nope' } as any)).rejects.toThrow()
    await expect(db.updateEntity('id', { content: 1 as any })).rejects.toThrow()
  })

  it('searchDocuments validates input and early-returns on empty query', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    // invalid: query not a string
    // @ts-expect-error
    await expect(db.searchDocuments({ query: 1 })).rejects.toThrow()

    // empty query => [] and should not hit DB
    const res = await db.searchDocuments({ query: '   ' })
    expect(res).toEqual([])
    expect(mockDbClient.query).not.toHaveBeenCalled()
  })

  it('searchEntities validates input and clamps weights/limit', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })
    await expect(
      // @ts-expect-error
      db.searchEntities({ query: 'ok', textWeight: '1' }),
    ).rejects.toThrow()

    await db.searchEntities({ query: 'q', textWeight: -5, limit: -1 })
    expect(mockDbClient.query).toHaveBeenCalled()
    const args = mockDbClient.query.mock.calls[0][1]
    // args: [query, qvec, limit, filterJSON, textWeight, semWeight, 50]
    expect(args[2]).toBe(1) // limit clamped to at least 1
    expect(args[4]).toBe(0) // textWeight clamped to [0,1]
    expect(args[5]).toBe(1) // semWeight = 1 - textWeight
  })

  it('matchDocuments rejects invalid options', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    // @ts-expect-error
    await expect(db.matchDocuments({ limit: 0 })).rejects.toThrow()
  })

  it('matchEntities accepts undefined options and builds null filter', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    mockDbClient.query.mockResolvedValue({ rows: [] })
    await db.matchEntities(undefined, undefined)
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL', [
      JSON.stringify({}),
      null,
      100,
    ])
  })

  it('clearDocuments without projectIds clears all', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    await db.clearDocuments()
    expect(mockDbClient.query).toHaveBeenCalledWith('FAKE_SQL')
  })

  it('updateEntity without content change does not compute embedding', async () => {
    const db = await openDatabase({ connectionString: 'test' })
    // getEntityById returns a row to allow update
    mockDbClient.query
      .mockResolvedValueOnce({ rows: [{ id: '123' }] }) // getEntityById
      .mockResolvedValueOnce({ rows: [{ id: '123', type: 'new' }] }) // update

    const res = await db.updateEntity('123', { type: 'new' })
    expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled()
    expect(res).toEqual({ id: '123', type: 'new' })
  })
})
