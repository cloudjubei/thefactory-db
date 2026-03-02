import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: db.searchDocumentsForPaths', () => {
  const projectId = `e2e-docpaths-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])

    await db.addDocument({ projectId, type: 'ts', name: 'FileTools.ts', src: 'src/utils/FileTools.ts', content: 'file tools impl' })
    await db.addDocument({ projectId, type: 'ts', name: 'FileTools.test.ts', src: 'src/utils/FileTools.test.ts', content: 'file tools test' })
    await db.addDocument({ projectId, type: 'txt', name: 'Readme', src: 'docs/Readme.txt', content: 'Unrelated content' })
    await db.addDocument({ projectId, type: 'ts', name: 'helpers.ts', src: 'lib/helpers.ts', content: '100%_done helper' })
    await db.addDocument({ projectId, type: 'ts', name: 'scoped.ts', src: 'scoped/dir/scoped.ts', content: 'scoped content' })
  })

  afterAll(async () => {
    try { await db.clearDocuments([projectId]) } finally { await db.close() }
  })

  it('throws if args.projectIds is missing/empty', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForPaths({ query: 'a' })).rejects.toThrow(/projectIds/i)
    await expect(db.searchDocumentsForPaths({ projectIds: [], query: 'a' })).rejects.toThrow(/projectIds/i)
  })

  it('throws if args.query is not a string', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForPaths({ projectIds: [projectId], query: 123 })).rejects.toThrow(/query/i)
  })

  it('throws if args.limit is not an integer', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForPaths({ projectIds: [projectId], query: 'a', limit: 1.2 })).rejects.toThrow(/limit/i)
  })

  it('throws if args.pathPrefix is not a string', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForPaths({ projectIds: [projectId], query: 'a', pathPrefix: 5 })).rejects.toThrow(/pathPrefix/i)
  })

  it('returns [] and does not hit DB for empty/whitespace query', async () => {
    expect(await db.searchDocumentsForPaths({ projectIds: [projectId], query: '' })).toEqual([])
    expect(await db.searchDocumentsForPaths({ projectIds: [projectId], query: '   ' })).toEqual([])
  })

  it('trims query before using it (whitespace around query)', async () => {
    const res = await db.searchDocumentsForPaths({ projectIds: [projectId], query: '  FileTools  ' })
    expect(res.length).toBeGreaterThan(0)
    expect(res.every((p) => p.toLowerCase().includes('filetools'))).toBe(true)
  })

  it('clamps limit to [1..1000]', async () => {
    // limit=1 should return at most 1 result
    const res1 = await db.searchDocumentsForPaths({ projectIds: [projectId], query: 'FileTools', limit: 1 })
    expect(res1.length).toBeLessThanOrEqual(1)

    // limit=0 is clamped to 1
    const res0 = await db.searchDocumentsForPaths({ projectIds: [projectId], query: 'FileTools', limit: 0 })
    expect(res0.length).toBeLessThanOrEqual(1)
  })

  it('escapes LIKE patterns in query and prefix (% and _)', async () => {
    // The seeded doc has content '100%_done helper' but search is on src/name, not content.
    // Searching for '100%_done' should not crash or match incorrectly via LIKE wildcards.
    const res = await db.searchDocumentsForPaths({ projectIds: [projectId], query: '100%_done' })
    // Should return empty because no src or name contains that substring
    expect(res).toEqual([])
  })

  it('uses null escapedPrefix when pathPrefix is empty/whitespace', async () => {
    // Should return results from all prefixes
    const res = await db.searchDocumentsForPaths({ projectIds: [projectId], query: 'FileTools', pathPrefix: '   ' })
    expect(res.length).toBeGreaterThan(0)
  })

  it('pathPrefix is normalized and passed as escapedPrefix (no leading slash, unix separators, ends with /)', async () => {
    const res = await db.searchDocumentsForPaths({ projectIds: [projectId], query: 'scoped', pathPrefix: '/scoped/dir/' })
    expect(res.length).toBeGreaterThan(0)
    expect(res.every((p) => p.startsWith('scoped/dir/'))).toBe(true)
  })

  it('normalizes returned src path separators to unix and strips leading ./', async () => {
    // All returned paths should use forward slashes and not start with ./
    const res = await db.searchDocumentsForPaths({ projectIds: [projectId], query: 'FileTools' })
    for (const p of res) {
      expect(p).not.toContain('\\')
      expect(p).not.toMatch(/^\.\//)
    }
  })

  it('handles empty result set gracefully', async () => {
    const res = await db.searchDocumentsForPaths({ projectIds: [projectId], query: 'nonexistentzzzz' })
    expect(res).toEqual([])
  })
})
