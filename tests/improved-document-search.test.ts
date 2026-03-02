import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { openDatabase } from '../src/index'
import { openPostgres } from '../src/connection'
import { createLogger } from '../src/logger'
import { createLocalEmbeddingProvider } from '../src/utils/embeddings'
import { SQL } from '../src/sql'

vi.mock('../src/connection')
vi.mock('../src/logger')
vi.mock('../src/utils/embeddings')

describe('Improved document search APIs (paths-only MVP)', () => {
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

  it('searchDocumentsForPaths returns [] and does not hit DB for empty/whitespace query', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    expect(await db.searchDocumentsForPaths({ projectIds: ['p1'], query: '' })).toEqual([])
    expect(await db.searchDocumentsForPaths({ projectIds: ['p1'], query: '   ' })).toEqual([])

    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it('searchDocumentsForKeywords returns [] and does not hit DB for empty tokenization result', async () => {
    const db = await openDatabase({ connectionString: 'x' })

    expect(await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: '' })).toEqual([])
    expect(await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ',;;  ,' })).toEqual([])

    expect(mockDb.query).not.toHaveBeenCalled()
  })

  it('searchDocumentsForPaths escapes LIKE patterns in query and prefix (% and _)', async () => {
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
    // pathPrefix normalization keeps slashes but escapes % and _
    expect(args[2]).toBe('a\\%/\\_b')
  })

  it('searchDocumentsForKeywords honors includeNameAndSrc=false and clamps limit to [1..1000]', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({
      projectIds: ['p1'],
      keywords: ['one'],
      includeNameAndSrc: false,
      limit: 5000,
    })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.keywordSearchDocumentsForPaths)
    expect(call).toBeTruthy()

    const args = call[1]
    // args: [projectIds, queryText, escapedPrefix, includeNameAndSrc, limit]
    expect(args[3]).toBe(false)
    expect(args[4]).toBe(1000)

    // and lower clamp
    mockDb.query.mockClear()
    await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ['one'], limit: 0 })
    const call2 = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.keywordSearchDocumentsForPaths)
    expect(call2[1][4]).toBe(1)
  })

  it('searchDocumentsForPaths normalizes returned src path separators to unix', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ src: 'a\\b\\c.md' }, { src: './d\\e.txt' }] })
    const db = await openDatabase({ connectionString: 'x' })

    const out = await db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'abc', limit: 2 })
    expect(out).toEqual(['a/b/c.md', 'd/e.txt'])

    expect(mockDb.query).toHaveBeenCalledWith(SQL.searchDocumentsForPaths, expect.any(Array))
  })

  it('searchDocumentsForKeywords tokenizes comma/semicolon separated input strings', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ src: 'x/y.md' }] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForKeywords({ projectIds: ['p1'], keywords: ' one, two; , three  ' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.keywordSearchDocumentsForPaths)
    expect(call).toBeTruthy()
    // args: [projectIds, queryText, escapedPrefix, includeNameAndSrc, limit]
    expect(call[1][1]).toBe('one two three')
  })

  it('searchDocumentsForExact defaults caseSensitive=true and tokenizes needles string', async () => {
    mockDb.query.mockResolvedValue({ rows: [{ src: 'x/y.md' }] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForExact({ projectIds: ['p1'], needles: ' Foo,Bar ; baz ' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.literalSearchDocumentsForPaths)
    expect(call).toBeTruthy()
    // args: [projectIds, queryText, escapedPrefix, includeNameAndSrc, caseSensitive, limit]
    expect(call[1][1]).toBe('Foo Bar baz')
    expect(call[1][4]).toBe(true)
  })

  it('pathPrefix is normalized and passed as escapedPrefix (no leading slash, unix separators)', async () => {
    mockDb.query.mockResolvedValue({ rows: [] })
    const db = await openDatabase({ connectionString: 'x' })

    await db.searchDocumentsForPaths({ projectIds: ['p1'], query: 'abc', pathPrefix: '/a\\b/' })

    const call = mockDb.query.mock.calls.find((c: any[]) => c[0] === SQL.searchDocumentsForPaths)
    expect(call).toBeTruthy()
    // args: [projectIds, escapedQuery, escapedPrefix, limit]
    expect(call[1][2]).toBe('a/b/')
  })
})
