import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)(
  'E2E: Documents Hybrid Search Advanced (real DB)',
  () => {
    const projectId = `e2e-docs-adv-${Date.now()}`
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

    it('ranks content, title-only (src), and semantic-only documents across weights [0,0.2,0.5,0.8,1]', async () => {
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

      const weights = [0, 0.2, 0.5, 0.8, 1]
      const resultsByW = await Promise.all(
        weights.map((w) =>
          db.searchDocuments({ query: 'car', projectIds: [projectId], textWeight: w, limit: 10 }),
        ),
      )

      const pos = (res: any[], id: string) => {
        const i = res.findIndex((r) => r.id === id)
        return i < 0 ? 999 : i
      }

      // d1 has exact keyword 'car' in content: should remain near top across weights
      for (const res of resultsByW) {
        expect(res.length).toBeGreaterThanOrEqual(3)
        expect(pos(res, d1.id)).toBeLessThanOrEqual(1) // top-2
      }

      // As textWeight increases, the title-only doc (src contains Car) should not fall behind semantic-only
      const positions = resultsByW.map((res) => ({ pD2: pos(res, d2.id), pD3: pos(res, d3.id) }))
      // At low text weight (semantic-dominant), semantic-only should be ahead of or equal to title-only
      expect(positions[0].pD3).toBeLessThanOrEqual(positions[0].pD2)
      // At high text weight (text-dominant), title-only should be ahead of or equal to semantic-only
      expect(positions[positions.length - 1].pD2).toBeLessThanOrEqual(
        positions[positions.length - 1].pD3,
      )

      // Score fields present
      for (const res of resultsByW) {
        for (const r of res) {
          expect(typeof r.totalScore).toBe('number')
          expect(typeof r.textScore === 'number' || r.textScore === null).toBe(true)
        }
      }
    })

    it('filename (src) contributes to textScore and retrieval when textWeight is high', async () => {
      //TODO: FIX this test is bad - the document is the only one in the database, so it will ALWAYS be returned; There should more documents present to test such a case.
      const doc = await db.addDocument({
        projectId,
        type: 'report',
        src: 'reports/Car-Guide.txt',
        content: 'completely unrelated content without the target keyword',
      })

      const highText = await db.searchDocuments({
        query: 'car',
        projectIds: [projectId],
        textWeight: 1,
        limit: 10,
      })

      // Should retrieve the doc based on filename tokenization
      const hit = highText.find((r) => r.id === doc.id)
      expect(hit).toBeTruthy()
      expect(hit && hit.textScore).toBeGreaterThan(0)
    })
  },
)
