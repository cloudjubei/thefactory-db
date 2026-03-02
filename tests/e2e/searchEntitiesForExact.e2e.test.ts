import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: db.searchEntitiesForExact', () => {
  const projectId = `e2e-entityexact-${Date.now()}`
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
    await expect(db.searchEntitiesForExact({ needles: 'a' })).rejects.toThrow(/projectIds/i)
    await expect(db.searchEntitiesForExact({ projectIds: [], needles: 'a' })).rejects.toThrow(/projectIds/i)
  })

  it('throws if args.needles is not string|string[]', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForExact({ projectIds: [projectId], needles: 1 })).rejects.toThrow(/needles/i)
  })

  it('throws if args.matchMode is invalid', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForExact({ projectIds: [projectId], needles: ['a'], matchMode: 'nope' })).rejects.toThrow(/matchMode/i)
  })

  it('throws if args.caseSensitive is not boolean', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForExact({ projectIds: [projectId], needles: ['a'], caseSensitive: 'yes' })).rejects.toThrow(/caseSensitive/i)
  })

  it('throws if args.types is not string[]', async () => {
    // @ts-expect-error
    await expect(db.searchEntitiesForExact({ projectIds: [projectId], needles: ['a'], types: 't1' })).rejects.toThrow(/types/i)
  })

  it('tokenizes when needles is string: split on comma/semicolon only', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: 'alpha, beta', caseSensitive: true, limit: 10 })
    expect(res.length).toBeGreaterThan(0)
  })

  it('drops empty tokens after tokenization', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: 'alpha,,; ,beta', caseSensitive: true, limit: 10 })
    expect(res.length).toBeGreaterThan(0)
  })

  it('returns [] if tokenization produces zero tokens', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ' , ;  ' })
    expect(res).toEqual([])
  })

  it('default matchMode is any', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ['alpha', 'gamma'], caseSensitive: true, limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)
    expect(texts).toContain('alpha beta gamma')
    expect(texts).toContain('alpha beta')
  })

  it('matchMode=all requires all needles', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ['alpha', 'gamma'], matchMode: 'all', caseSensitive: true, limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)
    expect(texts).toContain('alpha beta gamma')
    expect(texts).not.toContain('alpha beta')
  })

  it('default caseSensitive is true', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ['alpha'], limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)
    expect(texts).not.toContain('Alpha (uppercase) only once')
    expect(texts).toContain('alpha beta gamma')
  })

  it('caseSensitive=false includes differently-cased needle', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ['alpha'], caseSensitive: false, limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)
    expect(texts).toContain('Alpha (uppercase) only once')
  })

  it('type filter restricts results', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ['alpha'], caseSensitive: false, types: ['t2'], limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    expect(entities.every((e) => e?.type === 't2')).toBe(true)
  })

  it('clamps limit to [1..1000]', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ['alpha'], caseSensitive: false, limit: 0 })
    expect(res.length).toBeLessThanOrEqual(1)
  })

  it('ranking: more distinct needles matched ranks first', async () => {
    const res = await db.searchEntitiesForExact({ projectIds: [projectId], needles: ['alpha', 'beta', 'gamma'], caseSensitive: true, matchMode: 'any', limit: 10 })
    const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
    const texts = entities.map((e) => (e?.content as any)?.text as string)

    const ixA = texts.findIndex((t) => t === 'alpha beta gamma')
    const ixB = texts.findIndex((t) => t === 'alpha beta')
    const ixC = texts.findIndex((t) => t === 'beta only')
    expect(ixA).toBeGreaterThanOrEqual(0)
    expect(ixB).toBeGreaterThanOrEqual(0)
    expect(ixC).toBeGreaterThanOrEqual(0)
    expect(ixA).toBeLessThan(ixB)
    expect(ixB).toBeLessThan(ixC)
  })
})
