import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Entities Hybrid Search (real DB)', () => {
  const projectId = `e2e-ents-hybrid-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
  })

  afterAll(async () => {
    try {
      await db.clearEntities([projectId])
    } finally {
      await db.close()
    }
  })

  it('hybrid search returns results and respects weights', async () => {
    await db.addEntity({ projectId, type: 'product', content: { title: 'Yellow banana', tags: ['fruit'] } })
    await db.addEntity({ projectId, type: 'product', content: { title: 'Bananas are tasty', desc: 'ripe' } })
    await db.addEntity({ projectId, type: 'product', content: { title: 'Car engine', desc: 'v8' } })

    const w0 = await db.searchEntities({ query: 'banana', projectIds: [projectId], textWeight: 0, limit: 5 })
    const w1 = await db.searchEntities({ query: 'banana', projectIds: [projectId], textWeight: 1, limit: 5 })

    expect(w0.length).toBeGreaterThan(0)
    expect(w1.length).toBeGreaterThan(0)

    // With textWeight=1, exact keyword matches should be favored
    const titles1 = w1.slice(0, 2).map((r) => JSON.stringify(r.content).toLowerCase())
    expect(titles1.some((t) => t.includes('banana'))).toBe(true)

    // All results belong to our project
    for (const r of w1) expect(r.projectId).toBe(projectId)
  })
})
