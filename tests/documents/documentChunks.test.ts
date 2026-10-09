import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { CHUNK_MAX_CHARS } from '../../src/chunking/chunkingConstants'
import { createChunkWriter } from '../../src/client/documentChunks'

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex')

function fakes(stored: Record<string, string> = {}) {
  const queries: Array<{ sql: string; params: unknown[] }> = []
  const db = {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params })
      const hashes = params[0] as string[]
      return {
        rows: hashes
          .filter((h) => stored[h])
          .map((h) => ({ content_hash: h, embedding: stored[h] })),
      }
    }),
  }
  const embeddingProvider = {
    name: 'test-model',
    dimension: 2,
    embed: vi.fn(async (text: string) => new Float32Array([text.length, 1])),
    embedBatch: vi.fn(),
  }
  const embedded = () => embeddingProvider.embed.mock.calls.map(([text]) => text)
  const writer = createChunkWriter({ db, embeddingProvider, logger: { debug: vi.fn() } })
  return { writer, db, queries, embedded }
}

const longNotes = Array.from({ length: 60 }, (_, i) => `line ${i} of the notes`).join('\n')

describe('createChunkWriter.prepare', () => {
  it('keys each chunk by the model name and the chunk text', async () => {
    const { writer } = fakes()
    const [[chunk]] = await writer.prepare([{ src: 'a.txt', content: 'hello' }])
    expect(chunk.contentHash).toBe(sha1('test-model\na.txt\nhello'))
  })

  it('gives each chunk its embedding as vector text', async () => {
    const { writer } = fakes()
    const [[chunk]] = await writer.prepare([{ src: 'a.txt', content: 'hello' }])
    expect(chunk.embedding).toBe('[11,1]')
  })

  it('chunks a long document into several chunks within the chunk limit', async () => {
    const { writer } = fakes()
    const [chunks] = await writer.prepare([{ src: 'b.txt', content: longNotes }])
    expect(chunks.length).toBeGreaterThan(longNotes.length / CHUNK_MAX_CHARS)
  })

  it('embeds every chunk of every document, each on its own', async () => {
    const { writer, embedded } = fakes()
    const [small, big] = await writer.prepare([
      { src: 'a.txt', content: 'hello' },
      { src: 'b.txt', content: longNotes },
    ])
    expect(embedded()).toEqual([...small, ...big].map((c) => c.text))
  })

  it('looks up every distinct chunk hash in one query', async () => {
    const { writer, queries } = fakes()
    await writer.prepare([
      { src: 'a.txt', content: 'hello' },
      { src: 'b.txt', content: 'world' },
    ])
    expect(queries.map((q) => q.params[0])).toEqual([
      [sha1('test-model\na.txt\nhello'), sha1('test-model\nb.txt\nworld')],
    ])
  })

  it('reuses the stored embedding of a chunk hash already embedded', async () => {
    const reused = sha1('test-model\na.txt\nhello')
    const { writer } = fakes({ [reused]: '[9,9]' })
    const [[chunk]] = await writer.prepare([{ src: 'a.txt', content: 'hello' }])
    expect(chunk.embedding).toBe('[9,9]')
  })

  it('embeds only the chunks with no stored embedding', async () => {
    const { writer, embedded } = fakes({ [sha1('test-model\na.txt\nhello')]: '[9,9]' })
    await writer.prepare([
      { src: 'a.txt', content: 'hello' },
      { src: 'b.txt', content: 'world' },
    ])
    expect(embedded()).toEqual(['b.txt\nworld'])
  })

  it('embeds a chunk shared by several documents once', async () => {
    const { writer, embedded } = fakes()
    await writer.prepare([
      { src: 'same.txt', content: 'x' },
      { src: 'same.txt', content: 'x' },
    ])
    expect(embedded()).toEqual(['same.txt\nx'])
  })

  it('asks the store nothing for no documents', async () => {
    const { writer, db } = fakes()
    await writer.prepare([])
    expect(db.query).not.toHaveBeenCalled()
  })
})

describe('createChunkWriter.write', () => {
  it("replaces the document's chunks with the prepared ones, as parallel arrays", async () => {
    const { writer } = fakes()
    const [chunks] = await writer.prepare([{ src: 'a.ts', content: 'export const a = 1\n' }])
    const client = {
      query: vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({
        rows: [],
      })),
    }

    await writer.write(client, 'doc-1', 'p1', chunks)

    expect(client.query.mock.calls.map((c) => c[1])).toEqual([
      ['doc-1'],
      [
        'doc-1',
        'p1',
        [0],
        ['code'],
        [1],
        [1],
        [0],
        [18],
        [chunks[0].embedding],
        [chunks[0].contentHash],
      ],
    ])
  })

  it('only removes the stored chunks when given none', async () => {
    const { writer } = fakes()
    const client = {
      query: vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>(async () => ({
        rows: [],
      })),
    }

    await writer.write(client, 'doc-1', 'p1', [])

    expect(client.query.mock.calls.map((c) => c[1])).toEqual([['doc-1']])
  })
})
