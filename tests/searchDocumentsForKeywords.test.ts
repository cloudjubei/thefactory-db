import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { SQL } from '../src/sql'

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')

describe('db.searchDocumentsForKeywords', () => {
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
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(db.searchDocumentsForKeywords({ keywords: 'a' })).rejects.toThrow(/projectIds/i)
    await expect(db.searchDocumentsForKeywords({ projectIds: [], keywords: 'a' })).rejects.toThrow(
      /projectIds/i,
    )
  })

  it('throws if args.keywords is not string|string[]', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: 5 })).rejects.toThrow(
      /keywords/i,
    )
  })

  it('throws if args.matchMode is not any|all', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(
      db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: 'a', matchMode: 'nope' }),
    ).rejects.toThrow(/matchMode/i)
  })

  it('throws if args.limit is not an integer', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(
      db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: 'a', limit: 1.1 }),
    ).rejects.toThrow(/limit/i)
  })

  it('throws if args.pathPrefix is not a string', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(
      db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: 'a', pathPrefix: 5 }),
    ).rejects.toThrow(/pathPrefix/i)
  })

  it('returns [] and does not hit DB for empty tokenization result', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    expect(await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: '' })).toEqual([])
    expect(await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ',;;  ,' })).toEqual([])

    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it('tokenizes comma/semicolon separated input strings (trimming + dropping empties)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ' one, two; , three  ' })
    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForKeywords)
    expect(call).toBeTruthy()
    // args: [projectIds, tokens, matchMode, escapedPrefix, limit]
    expect(call[1][1]).toEqual(['one', 'two', 'three'])
  })

  it('does not split on spaces (string tokenization only splits on comma/semicolon)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: 'hello world' })
    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForKeywords)
    expect(call).toBeTruthy()
    expect(call[1][1]).toEqual(['hello world'])
  })

  it('passes matchMode=all through to SQL', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({
      projectIds: ['p1'],
      keywords: ['one', 'two'],
      matchMode: 'all',
    })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForKeywords)
    expect(call[1][2]).toBe('all')
  })

  it('defaults matchMode=any', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ['one', 'two'] })
    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForKeywords)
    expect(call[1][2]).toBe('any')
  })

  it('clamps limit to [1..1000]', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ['one'], limit: 5000 })
    let call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForKeywords)
    expect(call[1][4]).toBe(1000)

    mockDb.query.mockClear()
    await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ['one'], limit: 0 })
    call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForKeywords)
    expect(call[1][4]).toBe(1)
  })

  it('normalizes pathPrefix before passing it as escapedPrefix', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({
      projectIds: ['p1'],
      keywords: ['one'],
      pathPrefix: '/a\\b',
    })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForKeywords)
    expect(call[1][3]).toBe('a/b')
  })

  it('maps src results and normalizes to unix separators', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ src: 'a\\b.txt' }, { src: './c\\d.md' }] })
    const db = await openDatabase({ connectionString: 'x' })

    const out = await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ['one'] })
    expect(out).toEqual(['a/b.txt', 'c/d.md'])
  })

  it('handles DB returning undefined/null rows', async () => {
    mockDb.query.mockResolvedValue({ rows: undefined })
    const db = await openDatabase({ connectionString: 'x' })

    await expect(db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: 'one' })).resolves.toEqual([])
  })
})
