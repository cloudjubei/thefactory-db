import pg from 'pg'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'

import { CHUNKER_VERSION } from '../../src/chunking/chunkingConstants'
import { openDatabase } from '../../src/index'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

/** A long file whose only mention of refunds sits ~150 lines (several KB) in. */
function longFileWithDeepPassage(): { content: string; passageLine: number } {
  const lines: string[] = []
  for (let i = 0; i < 150; i++) {
    lines.push(`logger.configure({ level: 'info', transport: 'stdout', module: 'm${i}' })`)
  }
  const passageLine = lines.length + 1
  lines.push(
    '// Refund policy: customers may return any purchased item within 30 days for a full refund of the price paid.',
  )
  for (let i = 0; i < 40; i++) lines.push(`logger.flush('m${i}')`)
  return { content: lines.join('\n'), passageLine }
}

;(RUN && DATABASE_URL ? describe : describe.skip)(
  'E2E: Document chunks (real DB, real model)',
  () => {
    let db: Awaited<ReturnType<typeof openDatabase>>
    let raw: pg.Pool

    beforeAll(async () => {
      db = await openDatabase({ connectionString: DATABASE_URL, logLevel: 'error' })
      raw = new pg.Pool({ connectionString: DATABASE_URL })
    })

    afterAll(async () => {
      await raw.end()
      await db.close()
    })

    const chunkCount = async (documentId: string) =>
      Number(
        (
          await raw.query('SELECT count(*) FROM document_chunks WHERE document_id = $1', [
            documentId,
          ])
        ).rows[0].count,
      )

    it('finds a passage deep inside a long file by meaning alone, and points at its lines', async () => {
      const projectId = `e2e-chunks-deep-${Date.now()}`
      const { content, passageLine } = longFileWithDeepPassage()
      const [deep] = await db.upsertDocuments([
        { projectId, type: 'ts', src: 'src/logging.ts', name: 'logging.ts', content },
      ])
      await db.upsertDocuments([
        {
          projectId,
          type: 'md',
          src: 'docs/cooking.md',
          name: 'cooking.md',
          content: 'Simmer the onions slowly in butter until golden, then add stock.',
        },
        {
          projectId,
          type: 'md',
          src: 'docs/weather.md',
          name: 'weather.md',
          content: 'Tomorrow brings heavy rain in the north and sunshine in the south.',
        },
      ])
      expect(await chunkCount(deep.id)).toBeGreaterThan(5)

      const results = await db.searchDocuments({
        query: 'how many days do shoppers have to send back what they bought for their money back',
        projectIds: [projectId],
        textWeight: 0,
        limit: 3,
      })

      // Name matches are interleaved first ("do" matches docs/…), so compare semantic scores.
      const hit = results.find((r) => r.id === deep.id)
      const bestSemantic = [...results].sort((a, b) => (b.vecScore ?? 0) - (a.vecScore ?? 0))[0]
      expect(bestSemantic.id).toBe(deep.id)
      expect(hit?.matchedChunk?.startLine).toBeLessThanOrEqual(passageLine)
      expect(hit?.matchedChunk?.endLine).toBeGreaterThanOrEqual(passageLine)
      expect(content.slice(hit!.matchedChunk!.startChar, hit!.matchedChunk!.endChar)).toContain(
        'Refund policy',
      )

      await db.clearDocuments([projectId])
    })

    it('reports a document chunked by an older chunker as stale and re-chunks it on upsert', async () => {
      const projectId = `e2e-chunks-version-${Date.now()}`
      const doc = {
        projectId,
        type: 'md',
        src: 'a.md',
        name: 'a.md',
        content: 'alpha beta',
        fingerprint: 'f1',
      }
      const [stored] = await db.upsertDocuments([doc])
      await raw.query('UPDATE documents SET chunk_version = $2 WHERE id = $1', [
        stored.id,
        CHUNKER_VERSION - 1,
      ])
      await raw.query('DELETE FROM document_chunks WHERE document_id = $1', [stored.id])

      expect(
        await db.findStaleDocumentSrcs(projectId, [{ src: 'a.md', fingerprint: 'f1' }]),
      ).toEqual(['a.md'])
      expect(
        await db.findStaleDocumentSrcs(projectId, [{ src: 'a.md', fingerprint: 'f1' }], {
          includeOutdatedChunks: false,
        }),
      ).toEqual([])
      expect(await db.upsertDocuments([doc])).toHaveLength(1)

      expect(await chunkCount(stored.id)).toBe(1)
      expect(
        await db.findStaleDocumentSrcs(projectId, [{ src: 'a.md', fingerprint: 'f1' }]),
      ).toEqual([])
      await db.clearDocuments([projectId])
    })

    it('records the fingerprint of an outdated but unchanged document without re-chunking it, when told to', async () => {
      const projectId = `e2e-chunks-quick-${Date.now()}`
      const base = { projectId, type: 'md', src: 'a.md', name: 'a.md', content: 'alpha beta' }
      const [stored] = await db.upsertDocuments([{ ...base, fingerprint: 'f1' }])
      await raw.query('UPDATE documents SET chunk_version = $2 WHERE id = $1', [
        stored.id,
        CHUNKER_VERSION - 1,
      ])
      await raw.query('DELETE FROM document_chunks WHERE document_id = $1', [stored.id])

      const quick = await db.upsertDocuments([{ ...base, fingerprint: 'f2' }], {
        includeOutdatedChunks: false,
      })

      expect(quick).toEqual([])
      expect(await chunkCount(stored.id)).toBe(0)
      expect(
        await db.findStaleDocumentSrcs(projectId, [{ src: 'a.md', fingerprint: 'f2' }], {
          includeOutdatedChunks: false,
        }),
      ).toEqual([])
      expect(
        await db.findStaleDocumentSrcs(projectId, [{ src: 'a.md', fingerprint: 'f2' }]),
      ).toEqual(['a.md'])
      await db.clearDocuments([projectId])
    })

    it("deletes a document's chunks with it", async () => {
      const projectId = `e2e-chunks-cascade-${Date.now()}`
      const [stored] = await db.upsertDocuments([
        { projectId, type: 'md', src: 'a.md', name: 'a.md', content: 'gamma delta' },
      ])
      expect(await chunkCount(stored.id)).toBe(1)

      await db.deleteDocumentsBySrc(projectId, ['a.md'])

      expect(await chunkCount(stored.id)).toBe(0)
    })

    it('stores one summary chunk for a bulk data file', async () => {
      const projectId = `e2e-chunks-data-${Date.now()}`
      const content = JSON.stringify({
        candles: Array.from({ length: 8000 }, (_, i) => ({ t: i, c: i * 1.5 })),
      })
      const [stored] = await db.upsertDocuments([
        { projectId, type: 'json', src: 'prices/BTC.json', name: 'BTC.json', content },
      ])

      const rows = (
        await raw.query(
          'SELECT kind, start_char, end_char FROM document_chunks WHERE document_id = $1',
          [stored.id],
        )
      ).rows
      expect(rows).toEqual([{ kind: 'summary', start_char: 0, end_char: content.length }])
      await db.clearDocuments([projectId])
    })

    it('migrates a brand-new database from nothing and searches it', async () => {
      const name = `thefactory_fresh_${Date.now()}`
      await raw.query(`CREATE DATABASE ${name}`)
      const freshUrl = DATABASE_URL.replace(/\/[^/]+$/, `/${name}`)
      const fresh = await openDatabase({ connectionString: freshUrl, logLevel: 'error' })
      try {
        await fresh.upsertDocuments([
          {
            projectId: 'p',
            type: 'md',
            src: 'a.md',
            name: 'a.md',
            content: 'The cat sat on the warm windowsill.',
          },
        ])
        const results = await fresh.searchDocuments({
          query: 'a kitten resting by the window',
          projectIds: ['p'],
          textWeight: 0,
        })
        expect(results.map((r) => r.src)).toEqual(['a.md'])
        expect(results[0].matchedChunk).toMatchObject({ startLine: 1, endLine: 1 })
      } finally {
        await fresh.close()
        await raw.query(`DROP DATABASE ${name}`)
      }
    })
  },
)
