import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: db.searchDocumentsForExact', () => {
  const projectId = `e2e-docexact-${Date.now()}`
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
    await expect(db.searchDocumentsForExact({ needles: 'a' })).rejects.toThrow(/projectIds/i)
    await expect(db.searchDocumentsForExact({ projectIds: [], needles: 'a' })).rejects.toThrow(/projectIds/i)
  })

  it('throws if args.needles is not string|string[]', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForExact({ projectIds: [projectId], needles: 1 })).rejects.toThrow(/needles/i)
  })

  it('throws if args.matchMode is invalid', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForExact({ projectIds: [projectId], needles: ['a'], matchMode: 'nope' })).rejects.toThrow(/matchMode/i)
  })

  it('throws if args.caseSensitive is not boolean', async () => {
    // @ts-expect-error
    await expect(db.searchDocumentsForExact({ projectIds: [projectId], needles: ['a'], caseSensitive: 'yes' })).rejects.toThrow(/caseSensitive/i)
  })

  it('tokenizes when needles is string: split on comma/semicolon only', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: 'alpha, beta', caseSensitive: true, limit: 10 })
    expect(res).toContain('docs/a.txt')
    expect(res).toContain('docs/b.txt')
  })

  it('drops empty tokens after tokenization', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: 'alpha,,; ,beta', caseSensitive: true, limit: 10 })
    expect(res).toContain('docs/a.txt')
    expect(res).toContain('docs/b.txt')
  })

  it('returns [] if tokenization produces zero tokens', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ' , ;  ' })
    expect(res).toEqual([])
  })

  it('default matchMode is any', async () => {
    const any = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ['alpha', 'gamma'], caseSensitive: true, limit: 10 })
    expect(any).toContain('docs/a.txt')
    expect(any).toContain('docs/b.txt')
  })

  it('matchMode=all requires all needles', async () => {
    const all = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ['alpha', 'gamma'], matchMode: 'all', caseSensitive: true, limit: 10 })
    expect(all).toContain('docs/a.txt')
    expect(all).not.toContain('docs/b.txt')
  })

  it('default caseSensitive is true', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ['alpha'], limit: 10 })
    expect(res).not.toContain('docs/d.txt') // contains 'Alpha'
    expect(res).toContain('docs/a.txt')
  })

  it('caseSensitive=false includes differently-cased needle', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ['alpha'], caseSensitive: false, limit: 10 })
    expect(res).toContain('docs/d.txt')
  })

  it('pathPrefix scopes results', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ['alpha'], caseSensitive: true, pathPrefix: 'scoped', limit: 10 })
    expect(res).toEqual(['scoped/x.txt'])
  })

  it('clamps limit to [1..1000]', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ['alpha'], caseSensitive: true, limit: 0 })
    expect(res.length).toBeLessThanOrEqual(1)
  })

  it('ranking: more distinct needles matched ranks first', async () => {
    const res = await db.searchDocumentsForExact({ projectIds: [projectId], needles: ['alpha', 'beta', 'gamma'], caseSensitive: true, matchMode: 'any', limit: 10 })
    const ixA = res.indexOf('docs/a.txt')
    const ixB = res.indexOf('docs/b.txt')
    const ixC = res.indexOf('docs/c.txt')
    expect(ixA).toBeGreaterThanOrEqual(0)
    expect(ixB).toBeGreaterThanOrEqual(0)
    expect(ixC).toBeGreaterThanOrEqual(0)
    expect(ixA).toBeLessThan(ixB)
    expect(ixB).toBeLessThan(ixC)
  })
})
