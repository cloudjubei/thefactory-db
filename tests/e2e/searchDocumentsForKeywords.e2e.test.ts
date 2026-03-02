import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: db.searchDocumentsForKeywords', () => {
  const projectId = `e2e-dockeywords-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])

    await db.addDocument({ projectId, type: 'txt', name: 'A', src: 'docs/a.txt', content: 'alpha beta gamma' })
    await db.addDocument({ projectId, type: 'txt', name: 'B', src: 'docs/b.txt', content: 'alpha beta' })
    await db.addDocument({ projectId, type: 'txt', name: 'C', src: 'docs/c.txt', content: 'beta only' })
    await db.addDocument({ projectId, type: 'txt', name: 'D', src: 'docs/d.txt', content: 'Alpha (uppercase) only once' })
    await db.addDocument({ projectId, type: 'txt', name: 'Scoped', src: 'scoped/x.txt', content: 'alpha beta gamma' })
  })

  afterAll(async () => {
    try { await db.clearDocuments([projectId]) } finally { await db.close() }
  })

  it('throws if args.projectIds is missing/empty', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForKeywords({ keywords: 'a' })).rejects.toThrow(/projectIds/i)
    await expect(db.searchDocumentsForKeywords({ projectIds: [], keywords: 'a' })).rejects.toThrow(/projectIds/i)
  })

  it('throws if args.keywords is not string|string[]', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: 1 })).rejects.toThrow(/keywords/i)
  })

  it('throws if args.matchMode is invalid', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['a'], matchMode: 'nope' })).rejects.toThrow(/matchMode/i)
  })

  it('tokenizes when keywords is string: split on comma/semicolon only', async () => {
    // 'alpha beta' as a single token should still match document A because content contains that substring
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: 'alpha beta', limit: 10 })
    expect(res).toContain('docs/a.txt')

    // comma-separated should behave as two tokens and match more broadly
    const res2 = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: 'alpha, beta', limit: 10 })
    expect(res2).toContain('docs/a.txt')
    expect(res2).toContain('docs/b.txt')
  })

  it('drops empty tokens after tokenization', async () => {
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: 'alpha,,; ,beta', limit: 10 })
    expect(res).toContain('docs/a.txt')
    expect(res).toContain('docs/b.txt')
  })

  it('returns [] if tokenization produces zero tokens', async () => {
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ' , ;  ' })
    expect(res).toEqual([])
  })

  it('default matchMode is any', async () => {
    const any = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['alpha', 'gamma'], limit: 10 })
    expect(any).toContain('docs/a.txt')
    expect(any).toContain('docs/b.txt') // matches alpha
    expect(any).not.toContain('docs/c.txt') // no alpha/gamma
  })

  it('matchMode=all requires all tokens', async () => {
    const all = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['alpha', 'gamma'], matchMode: 'all', limit: 10 })
    expect(all).toContain('docs/a.txt')
    expect(all).not.toContain('docs/b.txt')
  })

  it('case-insensitive by default', async () => {
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['alpha'], limit: 10 })
    expect(res).toContain('docs/d.txt') // 'Alpha' should match
  })

  it('pathPrefix scopes results', async () => {
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['alpha'], pathPrefix: 'scoped', limit: 10 })
    expect(res).toEqual(['scoped/x.txt'])
  })

  it('clamps limit to [1..1000]', async () => {
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['alpha'], limit: 0 })
    expect(res.length).toBeLessThanOrEqual(1)
  })

  it('returns project-relative, unix-normalized paths', async () => {
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['alpha'], limit: 10 })
    for (const p of res) {
      expect(p).not.toContain('\\')
      expect(p).not.toMatch(/^\.\//)
    }
  })

  it('ranking: more distinct token matches rank first', async () => {
    const res = await db.searchDocumentsForKeywords({ projectIds: [projectId], keywords: ['alpha', 'beta', 'gamma'], matchMode: 'any', limit: 10 })
    const ixA = res.indexOf('docs/a.txt') // 3 tokens
    const ixB = res.indexOf('docs/b.txt') // 2 tokens
    const ixC = res.indexOf('docs/c.txt') // 1 token
    expect(ixA).toBeGreaterThanOrEqual(0)
    expect(ixB).toBeGreaterThanOrEqual(0)
    expect(ixC).toBeGreaterThanOrEqual(0)
    expect(ixA).toBeLessThan(ixB)
    expect(ixB).toBeLessThan(ixC)
  })
})
