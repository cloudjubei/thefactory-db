import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Documents Hybrid Search (real DB)', () => {
  const projectId = `e2e-hybrid-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])
  })

  afterAll(async () => {
    try {
      await db.clearDocuments([projectId])
    } finally {
      await db.close()
    }
  })

  it('ranks content, title-only (src), and semantic-only documents across weights', async () => {
    const d1 = await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/a.txt',
      content: 'This document talks about car and engine.',
    })
    const d2 = await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/Car-Notes.txt',
      content: 'This note is about vehicles and engines.',
    })
    const d3 = await db.addDocument({
      projectId,
      type: 'note',
      src: 'notes/auto.txt',
      content: 'This document is about automobile and engine.',
    })

    const weights = [0, 0.5, 1]
    const resultsByW = await Promise.all(
      weights.map((w) =>
        db.searchDocuments({ query: 'car', projectIds: [projectId], textWeight: w, limit: 10 }),
      ),
    )

    const pos = (res: any[], id: string) => {
      const i = res.findIndex((r) => r.id === id)
      return i < 0 ? 999 : i
    }

    // d1 has exact keyword 'car' in content: should be strong at textWeight=1
    expect(pos(resultsByW[2], d1.id)).toBeLessThanOrEqual(1)

    // d2 contains 'Car' only in src: improves with higher text weight
    const pSrcLow = pos(resultsByW[0], d2.id)
    const pSrcHigh = pos(resultsByW[2], d2.id)
    expect(pSrcHigh).toBeLessThanOrEqual(pSrcLow)

    // d3 mentions automobile (semantic relation). At semantic-only it should not be worse than at text-only.
    const pSemOnly = pos(resultsByW[0], d3.id)
    const pTextOnly = pos(resultsByW[2], d3.id)
    expect(pSemOnly).toBeLessThanOrEqual(pTextOnly)

    // All results come from our project and have scores present
    for (const res of resultsByW) {
      expect(res.length).toBeGreaterThan(0)
      for (const r of res) {
        expect(r.projectId).toBe(projectId)
        expect(typeof r.totalScore).toBe('number')
      }
    }
  })

  it('supports matchDocuments filtering by project', async () => {
    const res = await db.matchDocuments({ projectIds: [projectId], limit: 100 })
    expect(Array.isArray(res)).toBe(true)
    expect(res.every((d) => d.projectId === projectId)).toBe(true)
  })
})
