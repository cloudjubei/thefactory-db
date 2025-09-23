import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Updates and FTS regeneration (real DB)', () => {
  const projectId = `e2e-upd-fts-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])
    await db.clearEntities([projectId])
  })

  afterAll(async () => {
    try {
      await db.clearDocuments([projectId])
      await db.clearEntities([projectId])
    } finally {
      await db.close()
    }
  })

  it('documents: updates should regenerate updatedAt', async () => {
    const doc = await db.addDocument({
      projectId,
      type: 'note',
      src: `file-${Math.random().toString(36).slice(2)}.md`,
      content: 'initial content',
    })

    const t0 = new Date(doc.updatedAt).getTime()
    // ensure wall clock moves forward at least 1ms
    await new Promise((r) => setTimeout(r, 5))

    const upd = await db.updateDocument(doc.id, { content: 'changed content' })
    expect(upd).toBeTruthy()

    const t1 = new Date(upd!.updatedAt).getTime()
    expect(t1).toBeGreaterThan(t0)
  })

  it('entities: updates should regenerate updatedAt and FTS on content changes', async () => {
    const ent = await db.addEntity({
      projectId,
      type: 'product',
      content: { title: 'Alpha token', desc: 'first' },
    })

    // FTS should match "alpha" initially
    let r = await db
      .raw()
      .query(
        "SELECT fts @@ websearch_to_tsquery('english', $1) AS match FROM entities WHERE id = $2",
        ['alpha', ent.id],
      )
    expect(r.rows[0]?.match).toBe(true)

    const t0 = new Date(ent.updatedAt).getTime()
    await new Promise((r) => setTimeout(r, 5))

    const entUpd = await db.updateEntity(ent.id, { content: { title: 'Beta token', desc: 'second' } })
    expect(entUpd).toBeTruthy()

    // updatedAt must increase
    const t1 = new Date(entUpd!.updatedAt).getTime()
    expect(t1).toBeGreaterThan(t0)

    // FTS should no longer match "alpha" and should match "beta"
    r = await db
      .raw()
      .query(
        "SELECT fts @@ websearch_to_tsquery('english', $1) AS match FROM entities WHERE id = $2",
        ['alpha', ent.id],
      )
    expect(r.rows[0]?.match).toBe(false)

    r = await db
      .raw()
      .query(
        "SELECT fts @@ websearch_to_tsquery('english', $1) AS match FROM entities WHERE id = $2",
        ['beta', ent.id],
      )
    expect(r.rows[0]?.match).toBe(true)
  })
})
