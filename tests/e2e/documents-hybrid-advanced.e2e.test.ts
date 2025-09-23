import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)(
  'E2E: Documents Hybrid Search Advanced (real DB)',
  () => {
    const projectId = `e2e-docs-adv-${Date.now()}`
    let db: Awaited<ReturnType<typeof openDatabase>>

    // Seeded docs
    const ids = {
      contentStrong: [] as string[],
      titleOnly: [] as string[],
      semanticOnly: [] as string[],
      control: [] as string[],
    }

    beforeAll(async () => {
      db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
      await db.clearDocuments([projectId])

      // Seed ~20 documents
      // 1) Strong content matches for query 'car engine'
      for (let i = 0; i < 5; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'note',
          src: `notes/content-${i}.md`,
          content:
            'This document discusses car engine maintenance. The car engine is central to vehicle performance. Car engine tips and tricks.',
        })
        ids.contentStrong.push(d.id)
      }

      // 2) Title-only (src filename contains Car-Engine) but content lacks the literal tokens
      for (let i = 0; i < 5; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'note',
          src: `guides/Car-Engine-Guide-${i}.txt`,
          content:
            'Completely unrelated prose about gardening and cooking. No mention of the specific keywords, focusing on recipes and plants.',
        })
        ids.titleOnly.push(d.id)
      }

      // 3) Semantic-only (mentions synonyms automobile/motor but not exact terms 'car'/'engine')
      for (let i = 0; i < 5; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'note',
          src: `notes/auto-${i}.txt`,
          content:
            'This article covers automobile motor upkeep and advice. The automobile motor influences vehicle performance. Helpful tips for every driver.',
        })
        ids.semanticOnly.push(d.id)
      }

      // 4) Controls (unrelated)
      for (let i = 0; i < 5; i++) {
        const d = await db.addDocument({
          projectId,
          type: 'misc',
          src: `misc/${i}.txt`,
          content:
            'Random notes on tropical fruits like banana and mango. Nothing about vehicles or mechanics. Just fruit facts and recipes.',
        })
        ids.control.push(d.id)
      }
    })

    afterAll(async () => {
      try {
        await db.clearDocuments([projectId])
      } finally {
        await db.close()
      }
    })

    // Helpers
    async function run(query: string, w: number, limit = 30) {
      return db.searchDocuments({ query, projectIds: [projectId], textWeight: w, limit })
    }
    function pos(res: any[], id: string) {
      const i = res.findIndex((r) => r.id === id)
      return i < 0 ? 999 : i
    }

    // One test per weight for atomicity
    it('w=0 (semantic-only): semantic-only docs should outrank title-only docs and appear near the top-10', async () => {
      const res = await run('car engine', 0)
      expect(res.length).toBeGreaterThanOrEqual(10)

      // At least one semantic-only doc ranks ahead (lower index) than the best title-only doc
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      expect(bestSemantic).toBeLessThan(bestTitle)

      // Strong content matches should still be high due to semantic similarity
      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      expect(bestContent).toBeLessThanOrEqual(5)
    })

    it('w=0.2: both signals contribute; semantic-only present near top and title-only starts to surface', async () => {
      const res = await run('car engine', 0.2)
      expect(res.length).toBeGreaterThanOrEqual(10)

      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      expect(bestSemantic).toBeLessThanOrEqual(8)

      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      // Should begin to surface but not necessarily beat semantic-only yet
      expect(bestTitle).toBeLessThanOrEqual(15)

      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      expect(bestContent).toBeLessThanOrEqual(5)
    })

    it('w=0.5: balanced; both semantic-only and title-only appear in top-10', async () => {
      const res = await run('car engine', 0.5)
      expect(res.length).toBeGreaterThanOrEqual(10)

      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      expect(bestSemantic).toBeLessThanOrEqual(10)
      expect(bestTitle).toBeLessThanOrEqual(10)

      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      expect(bestContent).toBeLessThanOrEqual(3)
    })

    it('w=0.8: title-only (filename) should be stronger and appear in top-5', async () => {
      const res = await run('car engine', 0.8)
      expect(res.length).toBeGreaterThanOrEqual(10)

      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      expect(bestTitle).toBeLessThanOrEqual(5)

      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      expect(bestContent).toBeLessThanOrEqual(3)
    })

    it('w=1 (text-only): filename (src) match enables retrieval even with unrelated content', async () => {
      const res = await run('car engine', 1)
      expect(res.length).toBeGreaterThanOrEqual(10)

      // Filename-based docs should be clearly surfaced
      const bestTitle = Math.min(...ids.titleOnly.map((id) => pos(res, id)))
      expect(bestTitle).toBeLessThanOrEqual(3)

      // Semantic-only without exact keywords in text should lag
      const bestSemantic = Math.min(...ids.semanticOnly.map((id) => pos(res, id)))
      expect(bestSemantic).toBeGreaterThan(bestTitle)

      // Strong content keyword docs should be top ranked
      const bestContent = Math.min(...ids.contentStrong.map((id) => pos(res, id)))
      expect(bestContent).toBeLessThanOrEqual(2)
    })

    it('filename (src) contributes to textScore: top results include src hits when textWeight=1', async () => {
      const res = await run('car engine', 1)
      // ensure at least one of the top hits comes from titleOnly group (src contains Car-Engine)
      const top5 = res.slice(0, 5).map((r) => r.id)
      const hitFromTitle = ids.titleOnly.some((id) => top5.includes(id))
      expect(hitFromTitle).toBe(true)
    })
  },
)
