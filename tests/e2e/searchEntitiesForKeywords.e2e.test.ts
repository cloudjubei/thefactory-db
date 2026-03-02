import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: db.searchEntitiesForKeywords', () => {
  const projectId = `e2e-entitykeywords-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearEntities([projectId])

    await db.addEntity({ projectId, type: 't1', content: { text: 'alpha beta gamma' } })
    await db.addEntity({ projectId, type: 't1', content: { text: 'alpha beta' } })
    await db.addEntity({ projectId, type: 't1', content: { text: 'beta only' } })
    await db.addEntity({ projectId, type: 't2', content: { text: 'Alpha (uppercase) only once' } })
  })

  afterAll(async () => {
    try { await db.clearEntities([projectId]) } finally { await db.close() }
  })

  it('throws if args.projectIds is missing/empty', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForKeywords({ keywords: 'a' })).rejects.toThrow(/projectIds/i)
    await expect(db.searchEntitiesForKeywords({ projectIds: [], keywords: 'a' })).rejects.toThrow(/projectIds/i)
  })

  it('throws if args.keywords is not string|string[]', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: 1 })).rejects.toThrow(/keywords/i)
  })

  it('throws if args.matchMode is invalid', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['a'], matchMode: 'nope' })).rejects.toThrow(/matchMode/i)
  })

  it('throws if args.types is not string[]', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['a'], types: 't1' })).rejects.toThrow(/types/i)
  })

  it('tokenizes when keywords is string: split on comma/semicolon only', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: 'alpha, beta', limit: 10 })
    expect(res.length).toBeGreaterThan(0)
  })

  it('drops empty tokens after tokenization', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: 'alpha,,; ,beta', limit: 10 })
    expect(res.length).toBeGreaterThan(0)
  })

  it('returns [] if tokenization produces zero tokens', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ' , ;  ' })
    expect(res).toEqual([])
  })

  it('default matchMode is any', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['gamma', 'alpha'], limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)
    expect(texts).toContain('alpha beta gamma')
    expect(texts).toContain('alpha beta')
  })

  it('matchMode=all requires all tokens', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['alpha', 'gamma'], matchMode: 'all', limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)
    expect(texts).toContain('alpha beta gamma')
    expect(texts).not.toContain('alpha beta')
  })

  it('case-insensitive by default', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['alpha'], limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)
    expect(texts).toContain('Alpha (uppercase) only once')
  })

  it('type filter restricts results', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['alpha'], types: ['t2'], limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    expect(entities.every((e) => e?.type === 't2')).toBe(true)
  })

  it('clamps limit to [1..1000]', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['alpha'], limit: 0 })
    expect(res.length).toBeLessThanOrEqual(1)
  })

  it('ranking: more distinct token matches rank first', async () => {
    const res = await db.searchEntitiesForKeywords({ projectIds: [projectId], keywords: ['alpha', 'beta', 'gamma'], matchMode: 'any', limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)

    const ixA = texts.findIndex((t) => t === 'alpha beta gamma') // 3
    const ixB = texts.findIndex((t) => t === 'alpha beta') // 2
    const ixC = texts.findIndex((t) => t === 'beta only') // 1
    expect(ixA).toBeGreaterThanOrEqual(0)
    expect(ixB).toBeGreaterThanOrEqual(0)
    expect(ixC).toBeGreaterThanOrEqual(0)
    expect(ixA).toBeLessThan(ixB)
    expect(ixB).toBeLessThan(ixC)
  })
})
