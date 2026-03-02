import type { DB } from '../connection.js'
import type { Logger } from '../types.js'
import type { EmbeddingProvider } from '../utils/embeddings.js'
import { SQL } from '../sql.js'
import {
  buildEmbeddingTextForDoc,
  escapeLikePattern,
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
import type {
  Document,
  DocumentInput,
  DocumentPatch,
  DocumentUpsertInput,
  DocumentWithScore,
  MatchParams,
  SearchDocumentsForExactArgs,
  SearchDocumentsForKeywordsArgs,
  SearchDocumentsForPathsArgs,
  SearchParams,
} from '../types.js'

export function createDocumentApi({
  db,
  logger,
  embeddingProvider,
}: {
  db: DB
  logger: Logger
  embeddingProvider: EmbeddingProvider
}) {
  async function addDocument(d: DocumentInput): Promise<Document> {
    assertDocumentInput(d)
    logger.info('addDocument', { projectId: d.projectId, type: d.type, name: d.name, src: d.src })
    const content = d.content ?? ''
    const embInput = buildEmbeddingTextForDoc(d.type, content, d.name, d.src)
    const embedding = await embeddingProvider.embed(embInput)
    const out = await db.query(SQL.insertDocument, [
      d.projectId,
      d.type,
      d.src,
      d.name,
      content,
      toVectorLiteral(embedding),
      d.metadata ?? null,
    ])
    return out.rows[0]
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

  async function getChangingDocuments(projectId: string, inputs: DocumentUpsertInput[]) {
    const srcs = inputs.map((doc) => doc.src)
    const contents = inputs.map((doc) => doc.content ?? '')
    const result = await db.query(SQL.getChangingDocuments, [projectId, srcs, contents])
    return new Set(result.rows.map((row) => row.src))
  }

  async function upsertDocuments(inputs: DocumentUpsertInput[]): Promise<Document[]> {
    if (!inputs || inputs.length === 0) {
      return []
    }

    logger.info(`upsertDocuments: received a batch of ${inputs.length} documents`)
    const projectId = inputs[0].projectId
    const changingSrcs = await getChangingDocuments(projectId, inputs)
    if (changingSrcs.size === 0) {
      logger.info('upsertDocuments: no documents needed updating.')
      return []
    }

    const docsToUpsert = inputs.filter((doc) => changingSrcs.has(doc.src))
    logger.info(`upsertDocuments: ${docsToUpsert.length} of ${inputs.length} need updating.`)
    const embInputs = docsToUpsert.map((d) =>
      buildEmbeddingTextForDoc(d.type, d.content ?? '', d.name, d.src),
    )

    try {
      const embeddings = await Promise.all(embInputs.map((e) => embeddingProvider.embed(e)))

      const upsertedDocs = []
      await db.query('BEGIN')

      for (let i = 0; i < docsToUpsert.length; i++) {
        const doc = docsToUpsert[i]
        const embedding = embeddings[i]
        const embeddingLiteral = toVectorLiteral(embedding)
        const result = await db.query(SQL.upsertDocument, [
          doc.projectId,
          doc.type,
          doc.src,
          doc.name,
          doc.content,
          embeddingLiteral,
          doc.metadata ?? null,
        ])
        if (result.rows[0]) {
          upsertedDocs.push(result.rows[0])
        }
      }

      await db.query('COMMIT')
      logger.info(
        `Successfully upserted ${upsertedDocs.length} documents.`,
        upsertedDocs.map((d) => d.src),
      )
      return upsertedDocs
    } catch (e) {
      logger.error('Error in batch upsert, rolling back transaction', e)
      await db.query('ROLLBACK')
      throw e
    }
  }

  async function upsertDocument(input: DocumentUpsertInput): Promise<Document | undefined> {
    logger.info('upsertDocument', { src: input.src })
    const results = await upsertDocuments([input])
    return results[0]
  }

  async function updateDocument(id: string, patch: DocumentPatch): Promise<Document | undefined> {
    assertDocumentPatch(patch)
    logger.info('updateDocument', { id, name: patch.name })
    const exists = await getDocumentById(id)
    if (!exists) return

    let embeddingLiteral = null
    let newContent = null
    if (patch.content !== undefined) {
      newContent = patch.content ?? ''
      const emb = await embeddingProvider.embed(newContent)
      embeddingLiteral = toVectorLiteral(emb)
    }

    const r = await db.query(SQL.updateDocument, [
      id,
      patch.type ?? null,
      patch.src ?? null,
      patch.name ?? null,
      newContent,
      embeddingLiteral,
      patch.metadata ?? null,
    ])
    const updatedDocument = r.rows[0]
    if (!updatedDocument) {
      logger.warn('updateDocument failed: document not found', { id })
      return
    }
    return updatedDocument
  }

  async function deleteDocument(id: string): Promise<boolean> {
    logger.info('deleteDocument', { id })
    const r = await db.query(SQL.deleteDocument, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function matchDocuments(options: MatchParams): Promise<Document[]> {
    assertMatchParams(options)
    logger.info('matchDocuments', options)

    const filter: { types?: string[]; ids?: string[]; projectIds?: string[] } = {}
    if (options?.types && options.types.length > 0) filter.types = options.types
    if (options?.ids && options.ids.length > 0) filter.ids = options.ids
    if (options?.projectIds && options.projectIds.length > 0) filter.projectIds = options.projectIds

    const limit = Math.max(1, Math.min(1000, options?.limit ?? 20))
    const r = await db.query(SQL.matchDocuments, [
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])
    return r.rows
  }

  async function searchDocuments(params: SearchParams): Promise<DocumentWithScore[]> {
    assertSearchParams(params)
    logger.info('searchDocuments', params)

    const rawQuery = (params.query ?? '').trim()
    if (rawQuery.length <= 0) return []

    const query = prepareQuery(rawQuery)
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5)) / 2
    const keywordWeight = textWeight
    const semWeight = 1 - (textWeight + keywordWeight)
    const nameWeight = 10
    const limit = Math.max(1, Math.min(1000, params.limit ?? 20))

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
    ])
    const namePromise = db.query(SQL.searchDocumentsByName, [
      query,
      Math.min(limit, 10),
      filterJson,
    ])

    const [hybridRes, nameRes] = await Promise.all([hybridPromise, namePromise])
    const hybrid = hybridRes.rows || []
    const nameMatches = nameRes.rows || []
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
      } else if (j < hybrid.length) {
        picked = hybrid[j++]
      }
      pickName = !pickName
      if (!picked) continue
      if (seen.has(picked.id)) continue
      seen.add(picked.id)
      out.push(picked)
    }
    return out
  }

  async function searchDocumentsForPaths(args: SearchDocumentsForPathsArgs): Promise<string[]> {
    assertSearchDocumentsForPathsArgs(args)
    logger.info('searchDocumentsForPaths', args)

    const query = args.query.trim()
    if (!query) return []

    const limit = Math.max(1, Math.min(1000, args.limit ?? 20))
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

  async function searchDocumentsForKeywords(args: SearchDocumentsForKeywordsArgs): Promise<string[]> {
    assertSearchDocumentsForKeywordsArgs(args)
    logger.info('searchDocumentsForKeywords', args)

    const tokens = toTokens(args.keywords)
    if (tokens.length === 0) return []

    const limit = Math.max(1, Math.min(1000, args.limit ?? 20))
    const matchMode = args.matchMode ?? 'any'
    const pathPrefix = normalizePathPrefix(args.pathPrefix)
    const escapedPrefix = pathPrefix ? escapeLikePattern(pathPrefix) : null

    const r = await db.query(SQL.searchDocumentsForKeywords, [args.projectIds, tokens, matchMode, escapedPrefix, limit])

    return (r.rows || []).map((row: any) => normalizeDocPath(row.src))
  }

  async function searchDocumentsForExact(args: SearchDocumentsForExactArgs): Promise<string[]> {
    assertSearchDocumentsForExactArgs(args)
    logger.info('searchDocumentsForExact', args)

    const tokens = toTokens(args.needles)
    if (tokens.length === 0) return []

    const limit = Math.max(1, Math.min(1000, args.limit ?? 20))
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

    return (r.rows || []).map((row: any) => normalizeDocPath(row.src))
  }

  async function clearDocuments(projectIds?: string[]): Promise<void> {
    logger.info('clearDocuments', { count: projectIds?.length || 0 })
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
    searchDocuments,
    matchDocuments,
    clearDocuments,
    searchDocumentsForPaths,
    searchDocumentsForKeywords,
    searchDocumentsForExact,
  }
}
