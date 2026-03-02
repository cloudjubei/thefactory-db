import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)(
  'E2E: Documents Improved Search Ranking',
  () => {
    const projectId = `e2e-improved-docs-ranking-${Date.now()}`
    let db: Awaited<ReturnType<typeof openDatabase>>

    beforeAll(async () => {
      db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
      await db.clearDocuments([projectId])

      // DocA matches 3 distinct tokens: alpha, beta, gamma
      await db.addDocument({
        projectId,
        type: 'txt',
        name: 'DocA',
        src: 'docs/docA.txt',
        content: 'alpha beta gamma',
      })
      // DocB matches 2 distinct tokens: alpha, beta
      await db.addDocument({
        projectId,
        type: 'txt',
        name: 'DocB',
        src: 'docs/docB.txt',
        content: 'alpha beta',
      })
      // DocC matches only 1 token: beta
      await db.addDocument({
        projectId,
        type: 'txt',
        name: 'DocC',
        src: 'docs/docC.txt',
        content: 'beta only',
      })
      // DocD has 'Alpha' (uppercase) — for caseSensitive tests
      await db.addDocument({
        projectId,
        type: 'txt',
        name: 'DocD',
        src: 'docs/docD.txt',
        content: 'Alpha only once',
      })

      // Scoped doc for pathPrefix assertions
      await db.addDocument({
        projectId,
        type: 'txt',
        name: 'Scoped',
        src: 'scoped/x.txt',
        content: 'alpha beta gamma',
      })
    })

    afterAll(async () => {
      try {
        await db.clearDocuments([projectId])
      } finally {
        await db.close()
      }
    })

    it('keyword ranking: more distinct-token matches rank first (matchMode=any)', async () => {
      const res = await db.searchDocumentsForKeywords({
        projectIds: [projectId],
        keywords: ['alpha', 'beta', 'gamma'],
        matchMode: 'any',
        limit: 10,
      })

      // DocA (score=3) should appear before DocB (score=2)
      const ixA = res.indexOf('docs/docA.txt')
      const ixB = res.indexOf('docs/docB.txt')
      expect(ixA).toBeGreaterThanOrEqual(0)
      expect(ixB).toBeGreaterThanOrEqual(0)
      expect(ixA).toBeLessThan(ixB)

      // DocB (score=2) before DocC (score=1)
      const ixC = res.indexOf('docs/docC.txt')
      expect(ixC).toBeGreaterThanOrEqual(0)
      expect(ixB).toBeLessThan(ixC)
    })

    it('keyword matchMode=all requires all tokens to be present', async () => {
      const res = await db.searchDocumentsForKeywords({
        projectIds: [projectId],
        keywords: ['alpha', 'beta', 'gamma'],
        matchMode: 'all',
        limit: 10,
      })

      expect(res).toContain('docs/docA.txt')
      expect(res).toContain('scoped/x.txt')
      // DocB has only alpha+beta, DocC has only beta, DocD has only Alpha
      expect(res).not.toContain('docs/docB.txt')
      expect(res).not.toContain('docs/docC.txt')
      expect(res).not.toContain('docs/docD.txt')
    })

    it('exact ranking: more distinct-needle matches rank first (caseSensitive=false)', async () => {
      const res = await db.searchDocumentsForExact({
        projectIds: [projectId],
        needles: ['alpha', 'beta', 'gamma'],
        matchMode: 'any',
        caseSensitive: false,
        limit: 10,
      })

      // DocA (score=3) should appear before DocB (score=2)
      const ixA = res.indexOf('docs/docA.txt')
      const ixB = res.indexOf('docs/docB.txt')
      expect(ixA).toBeGreaterThanOrEqual(0)
      expect(ixB).toBeGreaterThanOrEqual(0)
      expect(ixA).toBeLessThan(ixB)

      // DocD contains 'Alpha' with capital A; caseSensitive=false should include it.
      expect(res).toContain('docs/docD.txt')
    })

    it('exact search: caseSensitive=true excludes differently-cased needle', async () => {
      const res = await db.searchDocumentsForExact({
        projectIds: [projectId],
        needles: ['alpha'],
        caseSensitive: true,
        limit: 10,
      })

      // DocD has 'Alpha' (uppercase A) — should NOT match case-sensitive 'alpha'
      expect(res).not.toContain('docs/docD.txt')
      // DocA and DocB have lowercase 'alpha' — should match
      expect(res).toContain('docs/docA.txt')
      expect(res).toContain('docs/docB.txt')
    })

    it('pathPrefix scopes results (only returns within prefix)', async () => {
      const res = await db.searchDocumentsForKeywords({
        projectIds: [projectId],
        keywords: ['alpha'],
        pathPrefix: 'scoped',
        limit: 20,
      })

      expect(res).toEqual(['scoped/x.txt'])
    })
  },
)
