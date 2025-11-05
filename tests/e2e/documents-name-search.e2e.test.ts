import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Documents Name/Src Direct Search', () => {
  const projectId = `e2e-name-${Date.now()}`
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    await db.clearDocuments([projectId])

    // Seed test docs
    await db.addDocument({
      projectId,
      type: 'ts',
      name: 'FileTools.ts',
      src: 'src/utils/FileTools.ts',
      content: '',
    })
    await db.addDocument({
      projectId,
      type: 'ts',
      name: 'FileTools.test.ts',
      src: 'src/utils/FileTools.test.ts',
      content: '',
    })
    await db.addDocument({
      projectId,
      type: 'txt',
      name: 'Readme',
      src: 'docs/Readme.txt',
      content: 'Unrelated content for control',
    })
  })

  afterAll(async () => {
    try {
      await db.clearDocuments([projectId])
    } finally {
      await db.close()
    }
  })

  it('query with extension returns expected docs in shorter-name-first order', async () => {
    const res = await db.searchDocuments({ query: 'FileTools.ts', projectIds: [projectId], limit: 5 })
    const names = res.map((r) => r.name)

    // First two should be the two FileTools docs in the correct order
    expect(names.slice(0, 2)).toEqual(['FileTools.ts', 'FileTools.test.ts'])

    // No duplicates
    const ids = res.map((r) => r.id)
    expect(new Set(ids).size).toEqual(ids.length)
  })

  it('query without extension also returns expected docs in shorter-name-first order', async () => {
    const res = await db.searchDocuments({ query: 'FileTools', projectIds: [projectId], limit: 5 })
    const names = res.map((r) => r.name)
    expect(names.slice(0, 2)).toEqual(['FileTools.ts', 'FileTools.test.ts'])
  })

  it('full path query prefers exact src equality (full_raw on src)', async () => {
    const res = await db.searchDocuments({ query: 'src/utils/FileTools.ts', projectIds: [projectId], limit: 5 })
    // The doc whose src exactly equals the full path should come first
    expect(res[0]?.name).toBe('FileTools.ts')
  })

  it('projectIds filter is honored', async () => {
    const res = await db.searchDocuments({ query: 'FileTools', projectIds: [projectId], limit: 5 })
    expect(res.every((r) => r.projectId === projectId)).toBe(true)
  })
})
