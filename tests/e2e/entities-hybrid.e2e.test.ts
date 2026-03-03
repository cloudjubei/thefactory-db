import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Entities Hybrid Search (real DB)', () => {
  const projectId = `e2e-ents-hybrid-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])
  })

  afterAll(async () => {
    try {
      await db.clearEntities([projectId])
    } finally {
      await db.close()
    }
  })

  it('hybrid search returns results and respects weights', async () => {
    await db.addEntity({
      projectId,
      type: 'product',
      content: { title: 'Yellow banana', tags: ['fruit'] },
    })
    await db.addEntity({
      projectId,
      type: 'product',
      content: { title: 'Bananas are tasty', desc: 'ripe' },
    })
    await db.addEntity({ projectId, type: 'product', content: { title: 'Car engine', desc: 'v8' } })

    const w0 = await db.searchEntities({
      query: 'banana',
      projectIds: [projectId],
      textWeight: 0,
      limit: 5,
    })
    const w1 = await db.searchEntities({
      query: 'banana',
      projectIds: [projectId],
      textWeight: 1,
      limit: 5,
    })

    expect(w0.length).toBeGreaterThan(0)
    expect(w1.length).toBeGreaterThan(0)

    // With textWeight=1, exact keyword matches should be favored
    const titles1 = w1.slice(0, 2).map((r) => JSON.stringify(r.content).toLowerCase())
    expect(titles1.some((t) => t.includes('banana'))).toBe(true)

    // All results belong to our project
    for (const r of w1) expect(r.projectId).toBe(projectId)
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
    })

    expect(results1[0].id).toBe(contentMatch.id)
    expect(results1[0].id).not.toBe(metadataMatch.id)

    // Search with textWeight=0 (semantic search)
    const results0 = await db.searchEntities({
      query: 'bicycle',
      projectIds: [projectId],
      textWeight: 0,
    })
    // Expect content match to be the top result
    expect(results0[0].id).toBe(contentMatch.id)
  })

  it('includes non-embedded entities and returns vecScore=0 for them', async () => {
    const embedded = await db.addEntity({
      projectId,
      type: 'note',
      content: { text: 'kiwi fruit note' },
    })

    const nonEmbedded = await db.addEntity({
      projectId,
      type: 'note',
      content: { text: 'kiwi fruit note (no embedding)' },
      shouldEmbed: false,
    })

    const results = await db.searchEntities({
      query: 'kiwi',
      projectIds: [projectId],
      // force a vector query path; non-embedded rows must not error and should get vecScore=0
      textWeight: 0,
      limit: 10,
    })

    const embeddedRow = results.find((r) => r.id === embedded.id)
    const nonEmbeddedRow = results.find((r) => r.id === nonEmbedded.id)

    expect(embeddedRow).toBeTruthy()
    expect(nonEmbeddedRow).toBeTruthy()

    // Non-embedded entities must not crash vector scoring; they should get a 0 vecScore.
    expect(nonEmbeddedRow!.vecScore).toBe(0)
    // Embedded entity should have some vector score (not necessarily >0 depending on embedding provider,
    // but it should not be forced to 0 by our NULL-guard).
    expect(embeddedRow!.vecScore).not.toBeNull()
  })
})
