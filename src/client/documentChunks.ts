import { createHash } from 'node:crypto'

import { chunkDocument } from '../chunking/chunkDocument.js'
import type { DocumentChunk } from '../chunking/chunkingTypes.js'
import { SQL } from '../sql.js'
import type { Logger } from '../types.js'
import type { EmbeddingProvider } from '../utils/embeddings.js'
import { toVectorLiteral } from '../utils.js'

/** A chunk ready to store: its cache key (model and text) and its embedding as vector text. */
export type PreparedChunk = DocumentChunk & { contentHash: string; embedding: string }

/** The one database call the writer makes: a pool, or a transaction's client. */
type Queryable = { query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> }

type StoredChunkEmbedding = { content_hash: string; embedding: string }

/**
 * Turns documents into stored chunks. `prepare` chunks them and embeds each chunk on its own (a
 * batched call pads its inputs and gave no speed-up), reusing the stored vector of any chunk whose
 * text this model already embedded (an unchanged function in an edited file, a file copied between
 * projects); `write` replaces one document's chunks inside the caller's transaction.
 */
export function createChunkWriter({
  db,
  embeddingProvider,
  logger,
}: {
  db: Queryable
  embeddingProvider: EmbeddingProvider
  logger: Pick<Logger, 'debug'>
}) {
  const keyOf = (text: string) =>
    createHash('sha1').update(`${embeddingProvider.name}\n${text}`).digest('hex')

  async function prepare(
    docs: Array<{ src: string; content: string }>,
  ): Promise<PreparedChunk[][]> {
    if (docs.length === 0) return []
    const chunked: Array<Array<DocumentChunk & { contentHash: string }>> = []
    for (const doc of docs) {
      const chunks = await chunkDocument(doc.src, doc.content)
      chunked.push(chunks.map((c) => ({ ...c, contentHash: keyOf(c.text) })))
    }

    const textByKey = new Map<string, string>()
    for (const chunks of chunked) for (const c of chunks) textByKey.set(c.contentHash, c.text)
    const stored = await db.query(SQL.findChunkEmbeddings, [[...textByKey.keys()]])
    const vectors = new Map<string, string>(
      (stored.rows as StoredChunkEmbedding[]).map((r) => [r.content_hash, r.embedding]),
    )
    const missing = [...textByKey.entries()].filter(([key]) => !vectors.has(key))
    const embedded = await Promise.all(missing.map(([, text]) => embeddingProvider.embed(text)))
    missing.forEach(([key], i) => vectors.set(key, toVectorLiteral(embedded[i])))
    logger.debug(
      `chunks: ${textByKey.size} distinct, ${textByKey.size - missing.length} reused, ${missing.length} embedded`,
    )

    return chunked.map((chunks) =>
      chunks.map((c) => ({ ...c, embedding: vectors.get(c.contentHash) as string })),
    )
  }

  async function write(
    client: Queryable,
    documentId: string,
    projectId: string,
    chunks: PreparedChunk[],
  ): Promise<void> {
    await client.query(SQL.deleteDocumentChunks, [documentId])
    if (chunks.length === 0) return
    await client.query(SQL.insertDocumentChunks, [
      documentId,
      projectId,
      chunks.map((c) => c.ord),
      chunks.map((c) => c.kind),
      chunks.map((c) => c.startLine),
      chunks.map((c) => c.endLine),
      chunks.map((c) => c.startChar),
      chunks.map((c) => c.endChar),
      chunks.map((c) => c.embedding),
      chunks.map((c) => c.contentHash),
    ])
  }

  return { prepare, write }
}

export type ChunkWriter = ReturnType<typeof createChunkWriter>
