import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Documents Indexing (real DB)', () => {
  const projectId = `e2e-docs-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
  })

  afterAll(async () => {
    try {
      await db.clearDocuments([projectId])
    } finally {
      await db.close()
    }
  })

  it('add/get/update/delete/getBySrc/clear', async () => {
    const created = await db.addDocument({
      projectId,
      type: 'note',
      src: `file-${Math.random().toString(36).slice(2)}.md`,
      content: 'hello world',
      metadata: { a: 1 },
    })
    expect(created.id).toBeTruthy()
    expect(created.projectId).toBe(projectId)
    expect(created.type).toBe('note')
    expect(created.src).toContain('file-')
    expect(created.content).toBe('hello world')
    expect(created.metadata).toEqual({ a: 1 })

    const byId = await db.getDocumentById(created.id)
    expect(byId?.id).toBe(created.id)

    const bySrc = await db.getDocumentBySrc(created.src)
    expect(bySrc?.id).toBe(created.id)

    const updated = await db.updateDocument(created.id, { content: 'updated', metadata: { b: 2 } })
    expect(updated?.content).toBe('updated')
    expect(updated?.metadata).toEqual({ b: 2 })

    const deleted = await db.deleteDocument(created.id)
    expect(deleted).toBe(true)

    const missing = await db.getDocumentById(created.id)
    expect(missing).toBeUndefined()

    // create multiple and clear by project
    await db.addDocument({ projectId, type: 'x', src: 'a', content: 'a' })
    await db.addDocument({ projectId, type: 'x', src: 'b', content: 'b' })
    await db.clearDocuments([projectId])
    const afterClear = await db.matchDocuments({ projectIds: [projectId], limit: 10 })
    expect(afterClear.length).toBe(0)
  })
})
