import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Entities upsert (real DB)', () => {
  const projectId = `e2e-ents-upsert-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
  })

  afterAll(async () => {
    try {
      await db.clearEntities({ projectIds: [projectId] })
    } finally {
      await db.close()
    }
  })

  it('upserts a keyed record in place on (projectId, type, externalKey)', async () => {
    const first = await db.upsertEntity({
      projectId,
      type: 'stock-quote',
      externalKey: 'AAPL',
      shouldEmbed: false,
      content: { symbol: 'AAPL', latest: { t: '2026-05-30', v: 185.1 } },
    })
    expect(first.externalKey).toBe('AAPL')

    const second = await db.upsertEntity({
      projectId,
      type: 'stock-quote',
      externalKey: 'AAPL',
      shouldEmbed: false,
      content: { symbol: 'AAPL', latest: { t: '2026-05-31', v: 187.2 } },
    })

    expect(second.id).toBe(first.id)
    expect((second.content as any).latest.v).toBe(187.2)

    const rows = await db.matchEntities(
      { symbol: 'AAPL' },
      { projectIds: [projectId], types: ['stock-quote'] },
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].externalKey).toBe('AAPL')
  })

  it('does not dedupe across different keys or keyless rows', async () => {
    await db.upsertEntity({
      projectId,
      type: 'note',
      externalKey: 'k1',
      shouldEmbed: false,
      content: { n: 1 },
    })
    await db.upsertEntity({
      projectId,
      type: 'note',
      externalKey: 'k2',
      shouldEmbed: false,
      content: { n: 2 },
    })
    await db.upsertEntity({ projectId, type: 'note', shouldEmbed: false, content: { n: 3 } })
    await db.upsertEntity({ projectId, type: 'note', shouldEmbed: false, content: { n: 3 } })

    const notes = await db.matchEntities(undefined, { projectIds: [projectId], types: ['note'] })
    expect(notes.length).toBe(4)
  })
})
