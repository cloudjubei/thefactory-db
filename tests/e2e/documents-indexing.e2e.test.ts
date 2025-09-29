import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Documents Indexing (real DB)', () => {
  const projectId = `e2e-docs-${Date.now()}`
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

  it('add/get/update/delete/getBySrc/clear', async () => {
    const src0 = `file-${Math.random().toString(36).slice(2)}.md`
    const created = await db.addDocument({
      projectId,
      type: 'note',
      name: src0,
      src: src0,
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

    // get by src requires projectId
    const bySrc = await db.getDocumentBySrc(projectId, created.src)
    expect(bySrc?.id).toBe(created.id)

    const updated = await db.updateDocument(created.id, { content: 'updated', metadata: { b: 2 } })
    expect(updated?.content).toBe('updated')
    expect(updated?.metadata).toEqual({ b: 2 })

    const deleted = await db.deleteDocument(created.id)
    expect(deleted).toBe(true)

    const missing = await db.getDocumentById(created.id)
    expect(missing).toBeUndefined()

    // create multiple and clear by project
    await db.addDocument({ projectId, type: 'x', name: 'a', src: 'a', content: 'a' })
    await db.addDocument({ projectId, type: 'x', name: 'b', src: 'b', content: 'b' })
    await db.clearDocuments([projectId])
    const afterClear = await db.matchDocuments({ projectIds: [projectId], limit: 10 })
    expect(afterClear.length).toBe(0)
  })

  it('upsertDocuments in a batch', async () => {
    const projectId = `e2e-docs-batch-${Date.now()}`
    await db.clearDocuments([projectId])

    // 1. Initial batch insert
    const initialDocs = [
      { projectId, type: 'post', src: 'p1', name: 'Post 1', content: 'This is the first post.' },
      { projectId, type: 'post', src: 'p2', name: 'Post 2', content: 'This is the second post.' },
      { projectId, type: 'post', src: 'p3', name: 'Post 3', content: 'This is the third post.' },
    ]

    const upserted = await db.upsertDocuments(initialDocs)
    expect(upserted.length).toBe(3)
    expect(upserted[0].src).toBe('p1')
    expect(upserted[1].src).toBe('p2')
    expect(upserted[2].src).toBe('p3')

    const allDocs = await db.matchDocuments({ projectIds: [projectId], limit: 10 })
    expect(allDocs.length).toBe(3)

    // 2. Mixed batch: update 2, insert 1 new, 1 unchanged
    const mixedDocs = [
      { projectId, type: 'post', src: 'p1', name: 'Post 1', content: 'This is the first post.' }, // unchanged
      { projectId, type: 'post', src: 'p2', name: 'Post 2 Updated', content: 'This is the second post, updated.' }, // updated
      { projectId, type: 'post', src: 'p3', name: 'Post 3 Updated', content: 'This is the third post, updated.' }, // updated
      { projectId, type: 'post', src: 'p4', name: 'Post 4', content: 'This is a new fourth post.' }, // new
    ]

    const upsertedMixed = await db.upsertDocuments(mixedDocs)
    expect(upsertedMixed.length).toBe(3)
    expect(upsertedMixed.map((d) => d.src).sort()).toEqual(['p2', 'p3', 'p4'])

    const allDocsAfterUpdate = await db.matchDocuments({ projectIds: [projectId], limit: 10 })
    expect(allDocsAfterUpdate.length).toBe(4)

    const p2 = await db.getDocumentBySrc(projectId, 'p2')
    expect(p2?.name).toBe('Post 2 Updated')

    const p4 = await db.getDocumentBySrc(projectId, 'p4')
    expect(p4?.name).toBe('Post 4')

    await db.clearDocuments([projectId])
  })
})
