import { createHash } from 'node:crypto'

import type { PoolClient } from 'pg'

import { CHUNKER_VERSION } from '../chunking/chunkingConstants.js'
import type { DB } from '../connection.js'
import { resolveCandidateLimit, SQL } from '../sql.js'
import type {
  Logger,
  Document,
  DocumentInput,
  DocumentPatch,
  DocumentSourceFingerprint,
  FindStaleDocumentsOptions,
  DocumentUpsertInput,
  DocumentWithScore,
  MatchParams,
  SearchDocumentsForExactArgs,
  SearchDocumentsForKeywordsArgs,
  SearchDocumentsForPathsArgs,
  SearchParams,
} from '../types.js'
import type { EmbeddingProvider } from '../utils/embeddings.js'
import { stripNullChars } from '../utils/json.js'
import {
  escapeLikePattern,
  nonIndexableReasonFor,
  normalizeDocPath,
  normalizePathPrefix,
  prepareQuery,
  toTokens,
  toVectorLiteral,
} from '../utils.js'
import {
  assertDocumentInput,
  assertDocumentPatch,
  assertMatchParams,
  assertSearchDocumentsForExactArgs,
  assertSearchDocumentsForKeywordsArgs,
  assertSearchDocumentsForPathsArgs,
  assertSearchParams,
} from '../validation.js'

import { createChunkWriter, type PreparedChunk } from './documentChunks.js'

/** One per batch connection, re-used for each document: a failed write rolls back to it and is undone alone. */
const DOCUMENT_UPSERT_SAVEPOINT = 'document_upsert'

/** An upsert input with its NUL-free content and that content's SHA-1, as Postgres would compute it. */
type HashedDocument = DocumentUpsertInput & { content: string; contentHash: string }

type HybridRow = DocumentWithScore & {
  chunkStartLine: number | null
  chunkEndLine: number | null
  chunkStartChar: number | null
  chunkEndChar: number | null
}

/** Folds the best chunk's span columns of a hybrid-search row into `matchedChunk`. */
function withMatchedChunk(row: HybridRow): DocumentWithScore {
  const { chunkStartLine, chunkEndLine, chunkStartChar, chunkEndChar, ...doc } = row
  return {
    ...doc,
    matchedChunk:
      chunkStartLine == null ||
      chunkEndLine == null ||
      chunkStartChar == null ||
      chunkEndChar == null
        ? null
        : {
            startLine: chunkStartLine,
            endLine: chunkEndLine,
            startChar: chunkStartChar,
            endChar: chunkEndChar,
          },
  }
}

export function createDocumentApi({
  db,
  logger,
  embeddingProvider,
}: {
  db: DB
  logger: Logger
  embeddingProvider: EmbeddingProvider
}) {
  const chunkWriter = createChunkWriter({ db, embeddingProvider, logger })

  /** Runs `work` in one transaction on a connection of its own, rolling back if it throws. */
  async function inTransaction<T>(
    errorMessage: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await db.connect()
    let releaseError: Error | undefined
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (e) {
      logger.error(errorMessage, e)
      try {
        await client.query('ROLLBACK')
      } catch (rollbackErr) {
        logger.error('documents: ROLLBACK failed', rollbackErr)
        releaseError = rollbackErr as Error
      }
      throw e
    } finally {
      client.release(releaseError)
    }
  }

  async function addDocument(d: DocumentInput): Promise<Document> {
    assertDocumentInput(d)
    logger.debug('addDocument', { projectId: d.projectId, type: d.type, name: d.name, src: d.src })
    const content = stripNullChars(d.content ?? '')
    const [chunks] = await chunkWriter.prepare([{ src: d.src, content }])
    return inTransaction('addDocument failed, rolling back', async (client) => {
      const out = await client.query(SQL.insertDocument, [
        d.projectId,
        d.type,
        d.src,
        d.name,
        content,
        null,
        d.metadata ?? null,
        d.fingerprint ?? null,
        CHUNKER_VERSION,
      ])
      const row = out.rows[0]
      await chunkWriter.write(client, row.id, d.projectId, chunks)
      return row
    })
  }

  async function getDocumentById(id: string): Promise<Document | undefined> {
    const r = await db.query(SQL.getDocumentById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row
  }

  async function getDocumentBySrc(projectId: string, src: string): Promise<Document | undefined> {
    const r = await db.query(SQL.getDocumentBySrc, [projectId, src])
    const row = r.rows[0]
    if (!row) return undefined
    return row
  }

  async function getChangingDocuments(
    projectId: string,
    docs: HashedDocument[],
    options: FindStaleDocumentsOptions,
  ) {
    const srcs = docs.map((doc) => doc.src)
    const hashes = docs.map((doc) => doc.contentHash)
    const result = await db.query(SQL.getChangingDocuments, [
      projectId,
      srcs,
      hashes,
      options.includeOutdatedChunks === false ? null : CHUNKER_VERSION,
    ])
    return new Set<string>(result.rows.map((row) => row.src))
  }

  async function refreshDocumentFingerprints(projectId: string, docs: HashedDocument[]) {
    const touched = docs.filter((doc) => doc.fingerprint !== undefined)
    if (touched.length === 0) return
    await db.query(SQL.refreshDocumentFingerprints, [
      projectId,
      touched.map((doc) => doc.src),
      touched.map((doc) => doc.contentHash),
      touched.map((doc) => doc.fingerprint),
    ])
  }

  async function findStaleDocumentSrcs(
    projectId: string,
    sources: DocumentSourceFingerprint[],
    options: FindStaleDocumentsOptions = {},
  ): Promise<string[]> {
    if (sources.length === 0) return []
    const r = await db.query(SQL.findStaleDocumentSrcs, [
      projectId,
      sources.map((s) => s.src),
      sources.map((s) => s.fingerprint),
      options.includeOutdatedChunks === false ? null : CHUNKER_VERSION,
    ])
    return r.rows.map((row) => row.src)
  }

  /** Writes the document row and, when one was written, its chunks — both undone together on failure. */
  async function inSavepoint(
    client: PoolClient,
    sql: string,
    params: unknown[],
    projectId: string,
    chunks: PreparedChunk[],
  ) {
    await client.query(`SAVEPOINT ${DOCUMENT_UPSERT_SAVEPOINT}`)
    try {
      const result = await client.query(sql, params)
      const row = result.rows[0] as Document | undefined
      if (row) await chunkWriter.write(client, row.id, projectId, chunks)
      await client.query(`RELEASE SAVEPOINT ${DOCUMENT_UPSERT_SAVEPOINT}`)
      return row
    } catch (e) {
      await client.query(`ROLLBACK TO SAVEPOINT ${DOCUMENT_UPSERT_SAVEPOINT}`)
      throw e
    }
  }

  /**
   * Writes one document inside the batch transaction. A document Postgres cannot index is stored
   * flagged, without its content or chunks; any other failure skips just this document.
   */
  async function storeDocument(
    client: PoolClient,
    doc: HashedDocument,
    chunks: PreparedChunk[],
  ): Promise<Document | undefined> {
    const { content } = doc
    try {
      return await inSavepoint(
        client,
        SQL.upsertDocument,
        [
          doc.projectId,
          doc.type,
          doc.src,
          doc.name,
          content,
          null,
          doc.metadata ?? null,
          doc.fingerprint ?? null,
          CHUNKER_VERSION,
        ],
        doc.projectId,
        chunks,
      )
    } catch (e) {
      const reason = nonIndexableReasonFor(e)
      if (!reason) {
        logger.error(`upsertDocuments: could not store ${doc.src}, skipped it`, e)
        return undefined
      }
      logger.warn(
        `upsertDocuments: ${doc.src} cannot be indexed (${reason}, ${Buffer.byteLength(content)} bytes); stored as non-indexable without its content`,
      )
      try {
        return await inSavepoint(
          client,
          SQL.upsertNonIndexableDocument,
          [
            doc.projectId,
            doc.type,
            doc.src,
            doc.name,
            content,
            doc.metadata ?? null,
            reason,
            doc.fingerprint ?? null,
            CHUNKER_VERSION,
          ],
          doc.projectId,
          [],
        )
      } catch (flagErr) {
        logger.error(`upsertDocuments: could not store ${doc.src}, skipped it`, flagErr)
        return undefined
      }
    }
  }

  /**
   * Upserts a batch in one transaction on a connection of its own. Each document is written in a
   * savepoint, so one that fails is skipped (or stored as non-indexable) without its batchmates.
   */
  async function upsertDocuments(
    inputs: DocumentUpsertInput[],
    options: FindStaleDocumentsOptions = {},
  ): Promise<Document[]> {
    if (!inputs || inputs.length === 0) {
      return []
    }

    logger.debug(`upsertDocuments: received a batch of ${inputs.length} documents`)
    const docs: HashedDocument[] = inputs.map((doc) => {
      const content = stripNullChars(doc.content ?? '')
      return { ...doc, content, contentHash: createHash('sha1').update(content).digest('hex') }
    })
    const projectId = docs[0].projectId
    const changingSrcs = await getChangingDocuments(projectId, docs, options)
    await refreshDocumentFingerprints(
      projectId,
      docs.filter((doc) => !changingSrcs.has(doc.src)),
    )
    if (changingSrcs.size === 0) {
      logger.debug('upsertDocuments: no documents needed updating.')
      return []
    }

    const docsToUpsert = docs.filter((doc) => changingSrcs.has(doc.src))
    logger.debug(`upsertDocuments: ${docsToUpsert.length} of ${docs.length} need updating.`)

    let chunks: PreparedChunk[][]
    try {
      chunks = await chunkWriter.prepare(docsToUpsert)
    } catch (e) {
      logger.error('upsertDocuments: embedding failed', e)
      throw e
    }

    return inTransaction('Error in batch upsert, rolling back transaction', async (client) => {
      const upsertedDocs: Document[] = []
      for (let i = 0; i < docsToUpsert.length; i++) {
        const stored = await storeDocument(client, docsToUpsert[i], chunks[i])
        if (stored) upsertedDocs.push(stored)
      }
      // Count only: dumping every `src` printed 100 file paths per batch, which
      // buried the rest of the log during a large project's initial ingestion.
      logger.debug(`upsertDocuments: upserted ${upsertedDocs.length} documents.`)
      return upsertedDocs
    })
  }

  async function upsertDocument(input: DocumentUpsertInput): Promise<Document | undefined> {
    logger.debug('upsertDocument', { src: input.src })
    const results = await upsertDocuments([input])
    return results[0]
  }

  /**
   * Patches a document. New content or a new path re-chunks it (a chunk's header names the path);
   * the row and its chunks are written in one transaction.
   */
  async function updateDocument(id: string, patch: DocumentPatch): Promise<Document | undefined> {
    assertDocumentPatch(patch)
    logger.debug('updateDocument', { id, name: patch.name })
    const exists = await getDocumentById(id)
    if (!exists) return

    const newContent = patch.content !== undefined ? stripNullChars(patch.content ?? '') : null
    const src = patch.src ?? exists.src
    const rechunk = newContent !== null || src !== exists.src
    const params = [
      id,
      patch.type ?? null,
      patch.src ?? null,
      patch.name ?? null,
      newContent,
      null,
      patch.metadata ?? null,
      CHUNKER_VERSION,
    ]

    let updatedDocument: Document | undefined
    if (!rechunk) {
      updatedDocument = (await db.query(SQL.updateDocument, params)).rows[0]
    } else {
      const [chunks] = await chunkWriter.prepare([{ src, content: newContent ?? exists.content }])
      updatedDocument = await inTransaction(
        'updateDocument failed, rolling back',
        async (client) => {
          const row = (await client.query(SQL.updateDocument, params)).rows[0]
          if (row) await chunkWriter.write(client, row.id, row.projectId, chunks)
          return row
        },
      )
    }
    if (!updatedDocument) {
      logger.warn('updateDocument failed: document not found', { id })
      return
    }
    return updatedDocument
  }

  async function deleteDocument(id: string): Promise<boolean> {
    const r = await db.query(SQL.deleteDocument, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function listDocumentSrcs(projectId: string): Promise<string[]> {
    const r = await db.query(SQL.listDocumentSrcs, [projectId])
    return r.rows.map((row: { src: string }) => row.src)
  }

  async function deleteDocumentsBySrc(projectId: string, srcs: string[]): Promise<number> {
    if (srcs.length === 0) return 0
    const r = await db.query(SQL.deleteDocumentsBySrc, [projectId, srcs])
    return r.rowCount ?? 0
  }

  async function matchDocuments(options: MatchParams): Promise<Document[]> {
    assertMatchParams(options)

    const filter: { types?: string[]; ids?: string[]; projectIds?: string[] } = {}
    if (options?.types && options.types.length > 0) filter.types = options.types
    if (options?.ids && options.ids.length > 0) filter.ids = options.ids
    if (options?.projectIds && options.projectIds.length > 0) filter.projectIds = options.projectIds

    const limit = Math.max(1, options?.limit ?? 20)
    const r = await db.query(SQL.matchDocuments, [
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])
    return r.rows
  }

  async function searchDocuments(params: SearchParams): Promise<DocumentWithScore[]> {
    assertSearchParams(params)

    const rawQuery = params.query.trim()
    if (rawQuery.length === 0) return []

    const query = prepareQuery(rawQuery)
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5)) / 2
    const keywordWeight = textWeight
    const semWeight = 1 - (textWeight + keywordWeight)
    const nameWeight = 10
    const limit = Math.max(1, params.limit ?? 20)

    const filter: { types?: string[]; ids?: string[]; projectIds?: string[] } = {}
    if (params.types && params.types.length > 0) filter.types = params.types
    if (params.ids && params.ids.length > 0) filter.ids = params.ids
    if (params.projectIds && params.projectIds.length > 0) filter.projectIds = params.projectIds
    const filterJson = Object.keys(filter).length ? JSON.stringify(filter) : JSON.stringify({})

    const hybridPromise = db.query(SQL.searchDocumentsQuery, [
      query,
      qvec,
      limit,
      filterJson,
      nameWeight,
      textWeight,
      keywordWeight,
      semWeight,
      50,
      resolveCandidateLimit(params.candidateLimit),
    ])
    const namePromise = db.query(SQL.searchDocumentsByName, [
      query,
      Math.min(limit, 10),
      filterJson,
    ])

    const [hybridRes, nameRes] = await Promise.all([hybridPromise, namePromise])
    const hybrid = hybridRes.rows.map(withMatchedChunk)
    const hybridById = new Map(hybrid.map((row) => [row.id, row]))
    const nameMatches = nameRes.rows.map((row) => hybridById.get(row.id) ?? row)
    const seen = new Set()
    const out = []
    let i = 0
    let j = 0
    let pickName = true
    while (out.length < limit && (i < nameMatches.length || j < hybrid.length)) {
      let picked
      if (pickName && i < nameMatches.length) {
        picked = nameMatches[i++]
      } else if (!pickName && j < hybrid.length) {
        picked = hybrid[j++]
      } else if (i < nameMatches.length) {
        picked = nameMatches[i++]
      } else {
        picked = hybrid[j++]
      }
      pickName = !pickName
      if (seen.has(picked.id)) continue
      seen.add(picked.id)
      out.push(picked)
    }
    return out
  }

  async function searchDocumentsForPaths(args: SearchDocumentsForPathsArgs): Promise<string[]> {
    assertSearchDocumentsForPathsArgs(args)
    logger.debug('searchDocumentsForPaths', args)

    const query = args.query.trim()
    if (!query) return []

    const limit = Math.max(1, args.limit ?? 20)
    const pathPrefix = normalizePathPrefix(args.pathPrefix)
    const escapedQuery = escapeLikePattern(query)
    const escapedPrefix = pathPrefix ? escapeLikePattern(pathPrefix) : null

    const r = await db.query(SQL.searchDocumentsForPaths, [
      args.projectIds,
      escapedQuery,
      escapedPrefix,
      limit,
    ])

    return (r.rows || []).map((row) => normalizeDocPath(row.src))
  }

  async function searchDocumentsForKeywords(
    args: SearchDocumentsForKeywordsArgs,
  ): Promise<string[]> {
    assertSearchDocumentsForKeywordsArgs(args)
    logger.debug('searchDocumentsForKeywords', args)

    const tokens = toTokens(args.keywords)
    if (tokens.length === 0) return []

    const limit = Math.max(1, args.limit ?? 20)
    const matchMode = args.matchMode ?? 'any'
    const pathPrefix = normalizePathPrefix(args.pathPrefix)
    const escapedPrefix = pathPrefix ? escapeLikePattern(pathPrefix) : null

    const r = await db.query(SQL.searchDocumentsForKeywords, [
      args.projectIds,
      tokens,
      matchMode,
      escapedPrefix,
      limit,
    ])

    return ((r.rows ?? []) as Array<{ src: string }>).map((row) => normalizeDocPath(row.src))
  }

  async function searchDocumentsForExact(args: SearchDocumentsForExactArgs): Promise<string[]> {
    assertSearchDocumentsForExactArgs(args)
    logger.debug('searchDocumentsForExact', args)

    const tokens = toTokens(args.needles)
    if (tokens.length === 0) return []

    const limit = Math.max(1, args.limit ?? 20)
    const matchMode = args.matchMode ?? 'any'
    const caseSensitive = args.caseSensitive ?? true
    const pathPrefix = normalizePathPrefix(args.pathPrefix)
    const escapedPrefix = pathPrefix ? escapeLikePattern(pathPrefix) : null
    const r = await db.query(SQL.searchDocumentsForExact, [
      args.projectIds,
      tokens,
      matchMode,
      caseSensitive,
      escapedPrefix,
      limit,
    ])

    return ((r.rows ?? []) as Array<{ src: string }>).map((row) => normalizeDocPath(row.src))
  }

  async function clearDocuments(projectIds?: string[]): Promise<void> {
    logger.debug('clearDocuments', { count: projectIds?.length || 0 })
    if (projectIds && projectIds.length > 0) {
      await db.query(SQL.clearDocumentsByProject, [projectIds])
    } else {
      await db.query(SQL.clearDocuments)
    }
  }

  return {
    addDocument,
    getDocumentById,
    getDocumentBySrc,
    upsertDocuments,
    upsertDocument,
    updateDocument,
    deleteDocument,
    listDocumentSrcs,
    findStaleDocumentSrcs,
    deleteDocumentsBySrc,
    searchDocuments,
    matchDocuments,
    clearDocuments,
    searchDocumentsForPaths,
    searchDocumentsForKeywords,
    searchDocumentsForExact,
  }
}
