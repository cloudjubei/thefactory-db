import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Document fingerprints', () => {
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'error' })
  })

  afterAll(async () => {
    await db.close()
  })

  it('reports sources never stored or stored under another fingerprint as stale', async () => {
    const projectId = `e2e-fp-stale-${Date.now()}`
    await db.upsertDocuments([
      {
        projectId,
        type: 'md',
        src: 'same.md',
        name: 'same.md',
        content: 'a',
        fingerprint: '1:100',
      },
      {
        projectId,
        type: 'md',
        src: 'moved.md',
        name: 'moved.md',
        content: 'b',
        fingerprint: '1:100',
      },
      { projectId, type: 'md', src: 'bare.md', name: 'bare.md', content: 'c' },
    ])

    const stale = await db.findStaleDocumentSrcs(projectId, [
      { src: 'same.md', fingerprint: '1:100' },
      { src: 'moved.md', fingerprint: '1:200' },
      { src: 'bare.md', fingerprint: '1:100' },
      { src: 'new.md', fingerprint: '1:100' },
    ])

    expect(stale.sort()).toEqual(['bare.md', 'moved.md', 'new.md'])
    await db.clearDocuments([projectId])
  })

  it('refreshes the fingerprint of a source touched without a content change, without rewriting it', async () => {
    const projectId = `e2e-fp-touch-${Date.now()}`
    const doc = { projectId, type: 'md', src: 'a.md', name: 'a.md', content: 'same text' }
    expect(await db.upsertDocuments([{ ...doc, fingerprint: '9:1' }])).toHaveLength(1)

    expect(await db.upsertDocuments([{ ...doc, fingerprint: '9:2' }])).toEqual([])

    expect(
      await db.findStaleDocumentSrcs(projectId, [{ src: 'a.md', fingerprint: '9:2' }]),
    ).toEqual([])
    expect((await db.getDocumentBySrc(projectId, 'a.md'))?.content).toBe('same text')
    await db.clearDocuments([projectId])
  })

  it('stores the fingerprint of a document it rewrites', async () => {
    const projectId = `e2e-fp-rewrite-${Date.now()}`
    const base = { projectId, type: 'md', src: 'a.md', name: 'a.md' }
    await db.upsertDocuments([{ ...base, content: 'v1', fingerprint: 'f1' }])
    await db.upsertDocuments([{ ...base, content: 'v2', fingerprint: 'f2' }])

    expect(await db.findStaleDocumentSrcs(projectId, [{ src: 'a.md', fingerprint: 'f2' }])).toEqual(
      [],
    )
    expect((await db.getDocumentBySrc(projectId, 'a.md'))?.content).toBe('v2')
    await db.clearDocuments([projectId])
  })

  it('stores the fingerprint of a document it flags as non-indexable', async () => {
    const projectId = `e2e-fp-nonidx-${Date.now()}`
    const words: string[] = []
    for (let i = 0; i < 200_000; i++) words.push(`q${i.toString(36).padStart(8, 'a')}`)
    await db.upsertDocuments([
      {
        projectId,
        type: 'json',
        src: 'BTC.json',
        name: 'BTC.json',
        content: words.join(' '),
        fingerprint: 'big',
      },
    ])

    expect((await db.getDocumentBySrc(projectId, 'BTC.json'))?.nonIndexableReason).toBe('too-large')
    expect(
      await db.findStaleDocumentSrcs(projectId, [{ src: 'BTC.json', fingerprint: 'big' }]),
    ).toEqual([])
    await db.clearDocuments([projectId])
  })
})
