import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { SQL } from '../src/sql'

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')

describe('db.searchDocumentsForPaths', () => {
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
    await expect(db.searchDocumentsForPaths({ query: 'a' })).rejects.toThrow(/projectIds/i)
    await expect(db.searchDocumentsForPaths({ projectIds: [], query: 'a' })).rejects.toThrow(
      /projectIds/i,
    )
  })

  it('throws if args.query is not a string', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(db.searchDocumentsForPaths({ projectIds: ['p1'], query: 123 })).rejects.toThrow(
      /query/i,
    )
  })

  it('throws if args.limit is not an integer', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'a', limit: 1.2 })).rejects.toThrow(
      /limit/i,
    )
  })

  it('throws if args.pathPrefix is not a string', async () => {
    const db = await openDatabase({ connectionString: 'x' })
    // @ts-expect-error
    await expect(
      db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'a', pathPrefix: 5 }),
    ).rejects.toThrow(/pathPrefix/i)
  })

  it('returns [] and does not hit DB for empty/whitespace query', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    expect(await db.searchDocumentsForPaths({ projectIds: ['p1'], query: '' })).toEqual([])
    expect(await db.searchDocumentsForPaths({ projectIds: ['p1'], query: '   ' })).toEqual([])

    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it('trims query before using it (whitespace around query)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForPaths({ projectIds: ['p1'], query: '  abc  ' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForPaths)
    expect(call).toBeTruthy()
    // args: [projectIds, escapedQuery, escapedPrefix, limit]
    expect(call[1][1]).toBe('abc')
  })

  it('clamps limit to [1..1000]', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'a', limit: 5000 })
    let call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForPaths)
    expect(call[1][3]).toBe(1000)

    mockDb.query.mockClear()
    await db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'a', limit: 0 })
    call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForPaths)
    expect(call[1][3]).toBe(1)
  })

  it('escapes LIKE patterns in query and prefix (% and _)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForPaths({
      projectIds: ['p1'],
      query: '100%_done',
      pathPrefix: 'a%/_b',
      limit: 20,
    })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForPaths)
    expect(call).toBeTruthy()

    const args = call[1]
    // args: [projectIds, escapedQuery, escapedPrefix, limit]
    expect(args[1]).toBe('100\\%\\_done')
    expect(args[2]).toBe('a\\%/\\_b')
  })

  it('uses null escapedPrefix when pathPrefix is empty/whitespace', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'abc', pathPrefix: '   ' })
    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForPaths)
    expect(call[1][2]).toBe(null)
  })

  it('pathPrefix is normalized and passed as escapedPrefix (no leading slash, unix separators, ends with /)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'abc', pathPrefix: '/a\\b/' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForPaths)
    expect(call).toBeTruthy()
    // args: [projectIds, escapedQuery, escapedPrefix, limit]
    expect(call[1][2]).toBe('a/b/')
  })

  it('normalizes returned src path separators to unix and strips leading ./', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ src: 'a\\b\\c.md' }, { src: './d\\e.txt' }] })
    const db = await openDatabase({ connectionString: 'x' })

    const out = await db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'abc', limit: 2 })
    expect(out).toEqual(['a/b/c.md', 'd/e.txt'])
  })

  it('handles DB returning undefined/null rows', async () => {
    mockDb.query.mockResolvedValue({ rows: undefined })
    const db = await openDatabase({ connectionString: 'x' })

    await expect(db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'abc' })).resolves.toEqual([])
  })
})
