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

    it('does not use metadata for search', async () => {
      const contentMatch = await db.addEntity({
        projectId,
        type: 'vehicle',
        content: { name: 'bicycle', color: 'red' },
        metadata: { irrelevant: true },
      })

      const metadataMatch = await db.addEntity({
        projectId,
        type: 'vehicle',
        content: { name: 'scooter', color: 'blue' },
        metadata: {
          relevantKeyword: 'bicycle bicycle bicycle',
          keyword2: 'bicycle',
          keyword3: 'bicycle',
        },
      })

      // Search with textWeight=1 (keyword search)
      const results1 = await db.searchEntities({
        query: 'bicycle',
        projectIds: [projectId],
        textWeight: 1,
        limit: 1,
      })

      const result1Ids = results1.map((r) => r.id)
      expect(result1Ids).toContain(contentMatch.id)
      expect(result1Ids).not.toContain(metadataMatch.id)

      // Search with textWeight=0 (semantic search)
      const results0 = await db.searchEntities({
        query: 'bicycle',
        projectIds: [projectId],
        textWeight: 0,
        limit: 1,
      })

      const results0Ids = results1.map((r) => r.id)
      expect(results0Ids).toContain(contentMatch.id)
      expect(results0Ids).not.toContain(metadataMatch.id)
    })
  },
)
;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Entities Keyword List Search', () => {
  const projectId = `e2e-ents-keywords-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  const ids = {
    matchAtStart: '' as string,
    matchInMiddle: '' as string,
    matchAtEnd: '' as string,
    noMatch: '' as string,
    semanticMatch: '' as string,
    partialMatch: '' as string,
  }

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearEntities([projectId])

    ids.matchAtStart = (
      await db.addEntity({
        projectId,
        type: 'product',
        content: {
          title: 'car engine maintenance guide',
          description: 'Important for vehicle longevity.',
        },
      })
    ).id

    ids.matchInMiddle = (
      await db.addEntity({
        projectId,
        type: 'product',
        content: {
          title: 'Guide to vehicle longevity',
          description: 'This guide is about car engine maintenance.',
        },
      })
    ).id

    ids.matchAtEnd = (
      await db.addEntity({
        projectId,
        type: 'product',
        content: {
          title: 'Vehicle Longevity',
          description: 'A comprehensive guide to vehicle care, including car engine maintenance.',
        },
      })
    ).id

    ids.noMatch = (
      await db.addEntity({
        projectId,
        type: 'product',
        content: {
          title: 'Gardening Tips',
          description: 'A guide to growing beautiful flowers.',
        },
      })
    ).id

    ids.semanticMatch = (
      await db.addEntity({
        projectId,
        type: 'product',
        content: {
          title: 'Automobile Motor Upkeep',
          description: 'A guide to keeping your vehicle in top shape.',
        },
      })
    ).id

    ids.partialMatch = (
      await db.addEntity({
        projectId,
        type: 'product',
        content: {
          title: 'Car Maintenance Guide',
          description: 'A guide to general car care.',
        },
      })
    ).id
  })

  afterAll(async () => {
    try {
      await db.clearEntities([projectId])
    } finally {
      await db.close()
    }
  })

  it('with textWeight=1, should only return entities with all keywords', async () => {
    const results = await db.searchEntities({
      query: 'car engine maintenance',
      projectIds: [projectId],
      textWeight: 1,
      limit: 3,
    })
    const resultIds = results.map((r) => r.id)

    expect(resultIds).not.toContain(ids.matchAtStart)
    expect(resultIds).toContain(ids.matchInMiddle)
    expect(resultIds).toContain(ids.matchAtEnd)
    expect(resultIds).not.toContain(ids.noMatch)
    expect(resultIds).not.toContain(ids.semanticMatch)
    expect(resultIds).toContain(ids.partialMatch)
  })

  it('with textWeight=0, should return semantically similar entities', async () => {
    const results = await db.searchEntities({
      query: 'car engine maintenance',
      projectIds: [projectId],
      textWeight: 0,
      limit: 5,
    })
    const resultIds = results.map((r) => r.id)

    expect(resultIds).toContain(ids.semanticMatch)
    expect(resultIds).toContain(ids.matchAtStart)
    expect(resultIds).toContain(ids.matchInMiddle)
    expect(resultIds).toContain(ids.matchAtEnd)
    expect(resultIds).toContain(ids.partialMatch)

    expect(resultIds).not.toContain(ids.noMatch)

    const semanticRank = results.findIndex((r) => r.id === ids.semanticMatch)
    const keywordRank = results.findIndex((r) => r.id === ids.matchAtStart)
    expect(keywordRank).toBeLessThan(semanticRank)
  })

  it('with textWeight=1 and no matching entities, should not match noMatch', async () => {
    const results = await db.searchEntities({
      query: 'pedicure',
      projectIds: [projectId],
      textWeight: 1,
      limit: 1,
    })
    const resultIds = results.map((r) => r.id)

    expect(resultIds).not.toContain(ids.noMatch)
  })
})
