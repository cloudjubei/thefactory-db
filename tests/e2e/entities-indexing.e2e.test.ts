import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Entities Indexing (real DB)', () => {
  const projectId = `e2e-entities-${Date.now()}`
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

  it('add/get/update/delete/match/clear', async () => {
    const created = await db.addEntity({
      projectId,
      type: 'user',
      content: { name: 'Alice', age: 30, skills: ['ts', 'db'] },
      metadata: { role: 'admin' },
    })
    expect(created.id).toBeTruthy()
    expect(created.projectId).toBe(projectId)
    expect(created.type).toBe('user')
    expect(created.metadata).toEqual({ role: 'admin' })

    const byId = await db.getEntityById(created.id)
    expect(byId?.id).toBe(created.id)

    const updated = await db.updateEntity(created.id, { content: { name: 'Alice', age: 31 }, type: 'person' })
    expect(updated?.type).toBe('person')

    const matched = await db.matchEntities({ name: 'Alice' }, { projectIds: [projectId], limit: 10 })
    expect(Array.isArray(matched)).toBe(true)
    expect(matched.some((e) => e.id === created.id)).toBe(true)

    const deleted = await db.deleteEntity(created.id)
    expect(deleted).toBe(true)

    const missing = await db.getEntityById(created.id)
    expect(missing).toBeUndefined()

    // create multiple and clear by project
    await db.addEntity({ projectId, type: 'user', content: { name: 'Bob' } })
    await db.addEntity({ projectId, type: 'user', content: { name: 'Carol' } })
    await db.clearEntities([projectId])
    const afterClear = await db.matchEntities(undefined, { projectIds: [projectId], limit: 10 })
    expect(afterClear.length).toBe(0)
  })
})
