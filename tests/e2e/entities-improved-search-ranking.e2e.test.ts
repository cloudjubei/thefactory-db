import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)(
  'E2E: Entities Improved Search Ranking',
  () => {
    const projectId = `e2e-improved-entities-ranking-${Date.now()}`
    let db: Awaited<ReturnType<typeof openDatabase>>

    beforeAll(async () => {
      db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
      await db.clearEntities([projectId])

      // Entity A: matches 3 distinct tokens (alpha, beta, gamma)
      await db.addEntity({ projectId, type: 't1', content: { text: 'alpha beta gamma' } })
      // Entity B: matches 2 distinct tokens (alpha, beta)
      await db.addEntity({ projectId, type: 't1', content: { text: 'alpha beta' } })
      // Entity C: matches 1 distinct token (beta only)
      await db.addEntity({ projectId, type: 't1', content: { text: 'beta beta beta' } })
      // Entity D: matches alpha (case-insensitive) — type t2 for filter test
      await db.addEntity({ projectId, type: 't2', content: { text: 'Alpha only once' } })
    })

    afterAll(async () => {
      try {
        await db.clearEntities([projectId])
      } finally {
        await db.close()
      }
    })

    it('keyword ranking: more distinct-token matches rank first (matchMode=any)', async () => {
      const res = await db.searchEntitiesForKeywords({
        projectIds: [projectId],
        keywords: ['alpha', 'beta', 'gamma'],
        matchMode: 'any',
        limit: 10,
      })

      const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
      const texts = entities.map((e) => (e?.content as any)?.text as string)

      // Entity A (score=3) should appear before Entity B (score=2)
      const ixA = texts.findIndex((t) => t === 'alpha beta gamma')
      const ixB = texts.findIndex((t) => t === 'alpha beta')
      expect(ixA).toBeGreaterThanOrEqual(0)
      expect(ixB).toBeGreaterThanOrEqual(0)
      expect(ixA).toBeLessThan(ixB)
    })

    it('keyword matchMode=all requires all tokens to be present', async () => {
      const res = await db.searchEntitiesForKeywords({
        projectIds: [projectId],
        keywords: ['alpha', 'beta'],
        matchMode: 'all',
        limit: 10,
      })

      const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
      const texts = entities.map((e) => (e?.content as any)?.text as string)

      expect(texts).toContain('alpha beta gamma')
      expect(texts).toContain('alpha beta')
      // beta-only and Alpha (case-insensitive but missing 'beta' in same row) should be excluded
      expect(texts).not.toContain('beta beta beta')
      expect(texts).not.toContain('Alpha only once')
    })

    it('exact search: caseSensitive=false includes differently-cased needle', async () => {
      const res = await db.searchEntitiesForExact({
        projectIds: [projectId],
        needles: ['alpha'],
        caseSensitive: false,
        limit: 10,
      })

      const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
      const texts = entities.map((e) => (e?.content as any)?.text as string)
      expect(texts).toContain('Alpha only once')
    })

    it('exact search: caseSensitive=true excludes differently-cased needle', async () => {
      const res = await db.searchEntitiesForExact({
        projectIds: [projectId],
        needles: ['alpha'],
        caseSensitive: true,
        limit: 10,
      })

      const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
      const texts = entities.map((e) => (e?.content as any)?.text as string)
      // 'Alpha only once' should NOT match because the 'A' is uppercase
      expect(texts).not.toContain('Alpha only once')
      // But these should match (contain lowercase 'alpha')
      expect(texts).toContain('alpha beta gamma')
      expect(texts).toContain('alpha beta')
    })

    it('type filter restricts results', async () => {
      const res = await db.searchEntitiesForKeywords({
        projectIds: [projectId],
        keywords: ['alpha'],
        types: ['t2'],
        limit: 10,
      })

      const entities = await Promise.all(res.map((id) => db.getEntityById(id)))
      expect(entities.every((e) => e?.type === 't2')).toBe(true)
    })
  },
)
