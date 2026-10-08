import { createHash } from 'node:crypto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

/** Distinct words whose lexemes alone exceed Postgres's 1 MB tsvector ceiling. */
function oversizedContent(): string {
  const words: string[] = []
  for (let i = 0; i < 200_000; i++) words.push(`q${i.toString(36).padStart(8, 'a')}`)
  return words.join(' ')
}

;(RUN && DATABASE_URL ? describe : describe.skip)('E2E: Documents that cannot be indexed', () => {
  let db: Awaited<ReturnType<typeof openDatabase>>

  beforeAll(async () => {
    db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'error' })
  })

  afterAll(async () => {
    await db.close()
  })

  it('stores an oversized document flagged as non-indexable and still commits its batchmates', async () => {
    const projectId = `e2e-nonidx-batch-${Date.now()}`
    const huge = oversizedContent()

    const upserted = await db.upsertDocuments([
      { projectId, type: 'md', src: 'a.md', name: 'a.md', content: 'alpha notes' },
      { projectId, type: 'json', src: 'data/BTC.json', name: 'BTC.json', content: huge },
      { projectId, type: 'md', src: 'b.md', name: 'b.md', content: 'beta notes' },
    ])

    expect(upserted.map((d) => d.src).sort()).toEqual(['a.md', 'b.md', 'data/BTC.json'])

    const flagged = await db.getDocumentBySrc(projectId, 'data/BTC.json')
    expect(flagged?.nonIndexableReason).toBe('too-large')
    expect(flagged?.content).toBe('')

    const kept = await db.getDocumentBySrc(projectId, 'a.md')
    expect(kept?.nonIndexableReason).toBeNull()
    expect(kept?.content).toBe('alpha notes')

    const byKeyword = await db.searchDocumentsForKeywords({
      keywords: ['beta'],
      projectIds: [projectId],
    })
    expect(byKeyword).toEqual(['b.md'])

    await db.clearDocuments([projectId])
  })

  it('does not retry an unchanged oversized document on the next upsert', async () => {
    const projectId = `e2e-nonidx-stable-${Date.now()}`
    const doc = {
      projectId,
      type: 'json',
      src: 'BTC.json',
      name: 'BTC.json',
      content: oversizedContent(),
    }

    const [flagged] = await db.upsertDocuments([doc])

    // Change detection compares this hash with the incoming content's; were it the hash of the empty
    // stored content, every ingestion would embed the file and have Postgres reject it again.
    expect(flagged.contentHash).toBe(createHash('sha1').update(doc.content).digest('hex'))
    expect(await db.upsertDocuments([doc])).toEqual([])

    await db.clearDocuments([projectId])
  })

  it('clears the flag once the document fits again', async () => {
    const projectId = `e2e-nonidx-shrink-${Date.now()}`
    const base = { projectId, type: 'json', src: 'BTC.json', name: 'BTC.json' }

    await db.upsertDocuments([{ ...base, content: oversizedContent() }])
    await db.upsertDocuments([{ ...base, content: '{"price": 1}' }])

    const doc = await db.getDocumentBySrc(projectId, 'BTC.json')
    expect(doc?.nonIndexableReason).toBeNull()
    expect(doc?.content).toBe('{"price": 1}')

    await db.clearDocuments([projectId])
  })

  it('clears the flag when updateDocument patches in content that fits', async () => {
    const projectId = `e2e-nonidx-patch-${Date.now()}`
    const [flagged] = await db.upsertDocuments([
      { projectId, type: 'json', src: 'BTC.json', name: 'BTC.json', content: oversizedContent() },
    ])

    const patched = await db.updateDocument(flagged.id, { content: 'small now' })

    expect(patched?.nonIndexableReason).toBeNull()
    expect(patched?.content).toBe('small now')
    const again = await db.upsertDocuments([
      { projectId, type: 'json', src: 'BTC.json', name: 'BTC.json', content: 'small now' },
    ])
    expect(again).toEqual([])

    await db.clearDocuments([projectId])
  })

  it('stores content containing NUL characters with them stripped', async () => {
    const projectId = `e2e-nonidx-nul-${Date.now()}`

    const upserted = await db.upsertDocuments([
      { projectId, type: 'js', src: 'app.js', name: 'app.js', content: 'const a\u0000 = 1' },
      { projectId, type: 'md', src: 'c.md', name: 'c.md', content: 'gamma' },
    ])

    expect(upserted.map((d) => d.src).sort()).toEqual(['app.js', 'c.md'])
    expect((await db.getDocumentBySrc(projectId, 'app.js'))?.content).toBe('const a = 1')
    expect(
      await db.upsertDocuments([
        { projectId, type: 'js', src: 'app.js', name: 'app.js', content: 'const a\u0000 = 1' },
      ]),
    ).toEqual([])

    await db.clearDocuments([projectId])
  })
})
