import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'
import { openPostgres } from '../../src/connection'
import { createLogger } from '../../src/logger'
import { createLocalEmbeddingProvider } from '../../src/utils/embeddings'
import { SQL } from '../../src/sql'
import { attachMigrationSupport } from '../utils/unitTestMocks'

vi.mock('../../src/connection')
vi.mock('../../src/logger')
vi.mock('../../src/utils/embeddings')

describe('db.searchEntitiesForExact', () => {
  let mockDb: any
  const mockLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  const mockEmb = { embed: vi.fn().mockResolvedValue(new Float32Array([0.1, 0.2, 0.3])) }

  beforeEach(() => {
    vi.clearAllMocks()

    mockDb = { query: vi.fn(), end: vi.fn() }
    attachMigrationSupport(mockDb)
    ;(openPostgres as unknown as any).mockResolvedValue(mockDb)
    ;(createLogger as unknown as any).mockReturnValue(mockLogger)
    ;(createLocalEmbeddingProvider as unknown as any).mockResolvedValue(mockEmb)
  })

  afterAll(async () => {
    await mockDb.end()
  })

  it('throws if args.projectIds is missing/empty', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(db.searchEntitiesForExact({ needles: 'a' } as any)).rejects.toThrow(/projectIds/i)
    await expect(db.searchEntitiesForExact({ projectIds: [], needles: 'a' })).rejects.toThrow(
      /projectIds/i,
    )
  })

  it('throws if args.needles is not string|string[]', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForExact({ projectIds: ['p1'], needles: 5 } as any),
    ).rejects.toThrow(/needles/i)
  })

  it('throws if args.matchMode is not any|all', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForExact({ projectIds: ['p1'], needles: 'a', matchMode: 'nope' } as any),
    ).rejects.toThrow(/matchMode/i)
  })

  it('throws if args.caseSensitive is not boolean', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForExact({ projectIds: ['p1'], needles: 'a', caseSensitive: 'y' } as any),
    ).rejects.toThrow(/caseSensitive/i)
  })

  it('throws if args.limit is not an integer', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForExact({ projectIds: ['p1'], needles: 'a', limit: 1.1 } as any),
    ).rejects.toThrow(/limit/i)
  })

  it('throws if args.types is not string[]', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })
    await expect(
      db.searchEntitiesForExact({ projectIds: ['p1'], needles: 'a', types: 't1' } as any),
    ).rejects.toThrow(/types/i)
  })

  it('returns [] and does not hit DB for empty tokenization result', async () => {
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    expect(await db.searchEntitiesForExact({ projectIds: ['p1'], needles: '' })).toEqual([])
    expect(await db.searchEntitiesForExact({ projectIds: ['p1'], needles: ',;;  ,' })).toEqual([])

    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it('defaults caseSensitive=true, defaults matchMode=any', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ id: 'e3' }] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    const ids = await db.searchEntitiesForExact({
      projectIds: ['p1'],
      needles: 'Hello',
      limit: 5,
    })

    expect(ids).toEqual(['e3'])
    expect(mockDb.query).toHaveBeenCalledWith(SQL.searchEntitiesForExact, [
      ['p1'],
      ['Hello'],
      'any',
      true,
      null,
      5,
    ])
  })

  it('tokenizes comma/semicolon separated input strings (trimming + dropping empties)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await db.searchEntitiesForExact({ projectIds: ['p1'], needles: ' Foo,Bar ; baz ' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForExact)
    expect(call).toBeTruthy()
    expect(call[1][1]).toEqual(['Foo', 'Bar', 'baz'])
  })

  it('passes matchMode=all through to SQL', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await db.searchEntitiesForExact({ projectIds: ['p1'], needles: ['a', 'b'], matchMode: 'all' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForExact)
    expect(call[1][2]).toBe('all')
  })

  it('passes caseSensitive=false through to SQL', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await db.searchEntitiesForExact({ projectIds: ['p1'], needles: ['a'], caseSensitive: false })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForExact)
    expect(call[1][3]).toBe(false)
  })

  it('supports caseSensitive=false and matchMode=all (and optional types filter)', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ id: 'e4' }] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    const ids = await db.searchEntitiesForExact({
      projectIds: ['p1'],
      needles: ['a', 'b'],
      matchMode: 'all',
      caseSensitive: false,
      types: ['t2'],
      limit: 50,
    })

    expect(ids).toEqual(['e4'])
    expect(mockDb.query).toHaveBeenCalledWith(SQL.searchEntitiesForExact, [
      ['p1'],
      ['a', 'b'],
      'all',
      false,
      ['t2'],
      50,
    ])
  })

  it('clamps limit to [1..]', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await db.searchEntitiesForExact({ projectIds: ['p1'], needles: ['a'], limit: 5_000_000 })
    let call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForExact)
    expect(call[1][5]).toBe(5_000_000)

    mockDb.query.mockClear()
    await db.searchEntitiesForExact({ projectIds: ['p1'], needles: ['a'], limit: 0 })
    call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchEntitiesForExact)
    expect(call[1][5]).toBe(1)
  })

  it('handles DB returning undefined/null rows', async () => {
    mockDb.query.mockResolvedValue({ rows: undefined })
    const db = await openDatabase({ connectionString: 'postgres://x', logLevel: 'silent' })

    await expect(
      db.searchEntitiesForExact({ projectIds: ['p1'], needles: 'one' }),
    ).resolves.toEqual([])
  })
})
