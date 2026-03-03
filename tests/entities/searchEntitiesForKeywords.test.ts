import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'
import { openPostgres } from '../../src/connection'
import { createLogger } from '../../src/logger'
import { createLocalEmbeddingProvider } from '../../src/utils/embeddings'
import { SQL } from '../../src/sql'

vi.mock('../../src/connection')
vi.mock('../../src/logger')
vi.mock('../../src/utils/embeddings')

describe('db.searchEntitiesForKeywords', () => {
  let mockDb: any
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const mockEmb = { embed: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])) }

  beforeEach(() => {
    vi.clearAllMocks()
    mockDb = { query: vi.fn(), end: vi.fn() }
    ;(openPostgres as unknown as any).mockResolvedValue(mockDb)
    ;(createLogger as unknown as any).mockReturnValue(mockLogger)
    ;(createLocalEmbeddingProvider as unknown as any).mockResolvedValue(mockEmb)
  })

  afterAll(async () => {
    await mockDb.end()
  })

  it('throws if args.projectIds is missing/empty', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(db.searchEntitiesForKeywords({ keywords: 'a' } as any)).rejects.toThrow(
      /projectIds/i,
    )
    await expect(db.searchEntitiesForKeywords({ projectIds: [], keywords: 'a' })).rejects.toThrow(
      /projectIds/i,
    )
  })

  it('throws if args.keywords is not string|string[]', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: 5 } as any),
    ).rejects.toThrow(/keywords/i)
  })

  it('throws if args.matchMode is not any|all', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: 'a', matchMode: 'nope' } as any),
    ).rejects.toThrow(/matchMode/i)
  })

  it('throws if args.limit is not an integer', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: 'a', limit: 1.1 } as any),
    ).rejects.toThrow(/limit/i)
  })

  it('throws if args.types is not string[]', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: 'a', types: 't1' } as any),
    ).rejects.toThrow(/types/i)
  })

  it('returns [] and does not hit DB for empty tokenization result', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    expect(await db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: '' })).toEqual([])
    expect(await db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: ',;;  ,' })).toEqual(
      [],
    )

    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it('tokenizes, defaults matchMode=any, returns ids', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ id: 'e1' }, { id: 'e2' }] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    const ids = await db.searchEntitiesForKeywords({
      projectIds: ['p1'],
      keywords: 'hello, world',
      limit: 10,
    })

    expect(ids).toEqual(['e1', 'e2'])
    expect(mockDb.query).toHaveBeenCalledWith(SQL.searchEntitiesForKeywords, [
      ['p1'],
      ['hello', 'world'],
      'any',
      null,
      10,
    ])
  })

  it('does not split on spaces (string tokenization only splits on comma/semicolon)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: 'hello world' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForKeywords)
    expect(call).toBeTruthy()
    expect(call[1][1]).toEqual(['hello world'])
  })

  it('supports matchMode=all and type filter', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ id: 'e9' }] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    const ids = await db.searchEntitiesForKeywords({
      projectIds: ['p1', 'p2'],
      keywords: ['hello', 'world'],
      matchMode: 'all',
      types: ['t1'],
      limit: 20,
    })

    expect(ids).toEqual(['e9'])
    expect(mockDb.query).toHaveBeenCalledWith(SQL.searchEntitiesForKeywords, [
      ['p1', 'p2'],
      ['hello', 'world'],
      'all',
      ['t1'],
      20,
    ])
  })

  it('defaults matchMode=any when omitted', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: ['a', 'b'] })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForKeywords)
    expect(call[1][2]).toBe('any')
  })

  it('clamps limit to [1..1000]', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: ['a'], limit: 5000 })
    let call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForKeywords)
    expect(call[1][4]).toBe(1000)

    mockDb.query.mockClear()
    await db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: ['a'], limit: 0 })
    call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForKeywords)
    expect(call[1][4]).toBe(1)
  })

  it('handles DB returning undefined/null rows', async () => {
    mockDb.query.mockResolvedValue({ rows: undefined })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await expect(
      db.searchEntitiesForKeywords({ projectIds: ['p1'], keywords: 'one' }),
    ).resolves.toEqual([])
  })
})
