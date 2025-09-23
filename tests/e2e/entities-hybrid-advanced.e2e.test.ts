import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)(
  'E2E: Entities Hybrid Search Advanced (real DB)',
  () => {
    const projectId = `e2e-ents-adv-${Date.now()}`
    let db: Awaited<ReturnType<typeof openDatabase>>

    const ids = {
      keyword: [] as string[],
      semantic: [] as string[],
      control: [] as string[],
    }

    beforeAll(async () => {
      db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
      await db.clearEntities([projectId])

      // Seed ~20 entities
      // 1) Keyword group (literal 'car' and 'engine' in fields)
      for (let i = 0; i < 7; i++) {
        const e = await db.addEntity({
          projectId,
          type: 'product',
          content: {
            title: `Car engine care ${i}`,
            desc: 'Tips for car engine maintenance and vehicle performance',
            tags: ['car', 'engine', 'vehicle'],
          },
        })
        ids.keyword.push(e.id)
      }

      // 2) Semantic group (synonyms: automobile/motor, avoid exact 'car'/'engine')
      for (let i = 0; i < 7; i++) {
        const e = await db.addEntity({
          projectId,
          type: 'product',
          content: {
            title: `Automobile motor basics ${i}`,
            desc: 'Advice for automobile motor upkeep and vehicle performance',
            tags: ['automobile', 'motor', 'vehicle'],
          },
        })
        ids.semantic.push(e.id)
      }

      // 3) Controls (unrelated)
      for (let i = 0; i < 6; i++) {
        const e = await db.addEntity({
          projectId,
          type: 'misc',
          content: {
            title: `Banana recipes ${i}`,
            desc: 'Notes on tropical fruits, banana and mango. No mechanics.',
            tags: ['banana', 'fruit'],
          },
        })
        ids.control.push(e.id)
      }
    })

    afterAll(async () => {
      try {
        await db.clearEntities([projectId])
      } finally {
        await db.close()
      }
    })

    // Helpers
    async function run(query: string, w: number, limit = 40) {
      return db.searchEntities({ query, projectIds: [projectId], textWeight: w, limit })
    }
    function pos(res: any[], id: string) {
      const i = res.findIndex((r) => r.id === id)
      return i < 0 ? 999 : i
    }

    it('w=0 (semantic-only): semantic entities appear above controls and near top', async () => {
      const res = await run('car engine', 0)
      expect(res.length).toEqual(20)

      const bestSemantic = Math.min(...ids.semantic.map((id) => pos(res, id)))
      const bestKeyword = Math.min(...ids.keyword.map((id) => pos(res, id)))
      const bestControl = Math.min(...ids.control.map((id) => pos(res, id)))

      // Semantic and keyword should both be far better than controls
      expect(bestSemantic).toBeLessThan(bestControl)
      expect(bestKeyword).toBeLessThan(bestControl)

      expect(bestKeyword).toBeLessThanOrEqual(0)
      expect(bestSemantic).toBeLessThanOrEqual(8)
    })

    it('w=0.2: both signals; semantic and keyword groups in top-10', async () => {
      const res = await run('car engine', 0.2)
      expect(res.length).toEqual(20)

      const bestSemantic = Math.min(...ids.semantic.map((id) => pos(res, id)))
      const bestKeyword = Math.min(...ids.keyword.map((id) => pos(res, id)))

      expect(bestSemantic).toBeLessThanOrEqual(10)
      expect(bestKeyword).toBeLessThanOrEqual(5)
    })

    it('w=0.5: balanced; both groups present in top-8', async () => {
      const res = await run('car engine', 0.5)
      expect(res.length).toBeGreaterThanOrEqual(15)

      const bestSemantic = Math.min(...ids.semantic.map((id) => pos(res, id)))
      const bestKeyword = Math.min(...ids.keyword.map((id) => pos(res, id)))

      expect(bestSemantic).toBeLessThanOrEqual(8)
      expect(bestKeyword).toBeLessThanOrEqual(5)
    })

    it('w=0.8: keyword dominance increases; keyword beats semantic', async () => {
      const res = await run('car engine', 0.8)
      expect(res.length).toBeGreaterThanOrEqual(15)

      const bestSemantic = Math.min(...ids.semantic.map((id) => pos(res, id)))
      const bestKeyword = Math.min(...ids.keyword.map((id) => pos(res, id)))

      expect(bestKeyword).toBeLessThan(bestSemantic)
      expect(bestKeyword).toBeLessThanOrEqual(3)
    })

    it('w=1 (text-only): keyword entities dominate top-3', async () => {
      const res = await run('car engine', 1)
      expect(res.length).toBeGreaterThanOrEqual(15)

      const bestKeyword = Math.min(...ids.keyword.map((id) => pos(res, id)))
      expect(bestKeyword).toBeLessThanOrEqual(2)
    })
  },
)
