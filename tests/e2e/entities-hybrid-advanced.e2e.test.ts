import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Entities Hybrid Search Advanced (real DB)', () => {
  const projectId = `e2e-ents-adv-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearEntities([projectId])
  })

  afterAll(async () => {
    try {
      await db.clearEntities([projectId])
    } finally {
      await db.close()
    }
  })

  it('balances keyword vs semantic signals across weights [0,0.2,0.5,0.8,1]', async () => {
    // e1: exact keyword 'car'
    const e1 = await db.addEntity({
      projectId,
      type: 'product',
      content: { title: 'Car engine', tags: ['vehicle', 'motor'] },
    })
    // e2: semantic-only (no literal 'car', but related)
    const e2 = await db.addEntity({
      projectId,
      type: 'product',
      content: { title: 'Automobile motor', desc: 'power unit for vehicles' },
    })
    // e3: unrelated control
    const e3 = await db.addEntity({
      projectId,
      type: 'product',
      content: { title: 'Yellow banana', tags: ['fruit'] },
    })

    const weights = [0, 0.2, 0.5, 0.8, 1]
    const resultsByW = await Promise.all(
      weights.map((w) =>
        db.searchEntities({ query: 'car', projectIds: [projectId], textWeight: w, limit: 10 }),
      ),
    )

    const pos = (res: any[], id: string) => {
      const i = res.findIndex((r) => r.id === id)
      return i < 0 ? 999 : i
    }

    // e1 should rank very high across weights
    for (const res of resultsByW) {
      expect(res.length).toBeGreaterThanOrEqual(3)
      expect(pos(res, e1.id)).toBeLessThanOrEqual(1) // top-2
    }

    // At semantic-only (w=0), semantically related e2 should outrank unrelated e3
    expect(pos(resultsByW[0], e2.id)).toBeLessThan(pos(resultsByW[0], e3.id))

    // At text-only (w=1), keyword e1 should outrank e2 (which lacks literal 'car')
    expect(pos(resultsByW[resultsByW.length - 1], e1.id)).toBeLessThan(pos(resultsByW[resultsByW.length - 1], e2.id))

    // Score fields present
    for (const res of resultsByW) {
      for (const r of res) {
        expect(typeof r.totalScore).toBe('number')
        expect(typeof r.textScore === 'number' || r.textScore === null).toBe(true)
      }
    }
  })
})
