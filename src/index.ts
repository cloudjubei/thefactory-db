import { DB, openPostgres } from './connection.js'
import { createLogger } from './logger.js'
import type {
  Document,
  DocumentInput,
  DocumentPatch,
  DocumentUpsertInput,
  DocumentWithScore,
  Entity,
  EntityInput,
  EntityPatch,
  EntityWithScore,
  MatchParams,
  OpenDbOptions,
  SearchDocumentsForExactArgs,
  SearchDocumentsForKeywordsArgs,
  SearchDocumentsForPathsArgs,
  SearchParams,
} from './types.js'
import { createLocalEmbeddingProvider } from './utils/embeddings.js'
import { SQL } from './sql.js'
import { stringifyJsonValues } from './utils/json.js'
import {
  assertDocumentInput,
  assertDocumentPatch,
  assertEntityInput,
  assertEntityPatch,
  assertMatchParams,
  assertSearchDocumentsForExactArgs,
  assertSearchDocumentsForKeywordsArgs,
  assertSearchDocumentsForPathsArgs,
  assertSearchParams,
} from './validation.js'
import {
  buildEmbeddingTextForDoc,
  escapeLikePattern,
  normalizeDocPath,
  normalizePathPrefix,
  prepareQuery,
  toTokens,
  toVectorLiteral,
} from './utils.js'

export interface TheFactoryDb {
  addEntity(e: EntityInput): Promise<Entity>
  getEntityById(id: string): Promise<Entity | undefined>
  updateEntity(id: string, patch: EntityPatch): Promise<Entity | undefined>
  deleteEntity(id: string): Promise<boolean>
  searchEntities(params: SearchParams): Promise<EntityWithScore[]>
  matchEntities(criteria: any | undefined, options?: MatchParams): Promise<Entity[]>
  clearEntities(projectIds?: string[]): Promise<void>

  addDocument(d: DocumentInput): Promise<Document>
  getDocumentById(id: string): Promise<Document | undefined>
  getDocumentBySrc(projectId: string, src: string): Promise<Document | undefined>
  upsertDocuments(inputs: DocumentUpsertInput[]): Promise<Document[]>
  upsertDocument(input: DocumentUpsertInput): Promise<Document | undefined>
  updateDocument(id: string, patch: DocumentPatch): Promise<Document | undefined>
  deleteDocument(id: string): Promise<boolean>
  matchDocuments(options: MatchParams): Promise<Document[]>
  clearDocuments(projectIds?: string[]): Promise<void>

  searchDocuments(params: SearchParams): Promise<DocumentWithScore[]>
  searchDocumentsForPaths(args: SearchDocumentsForPathsArgs): Promise<string[]>
  searchDocumentsForKeywords(args: SearchDocumentsForKeywordsArgs): Promise<string[]>
  searchDocumentsForExact(args: SearchDocumentsForExactArgs): Promise<string[]>

  close(): Promise<void>
  raw(): DB
}

export async function openDatabase({
  connectionString,
  logLevel,
}: OpenDbOptions): Promise<TheFactoryDb> {
  const logger = createLogger(logLevel)
  const db = await openPostgres(connectionString)
  const embeddingProvider = await createLocalEmbeddingProvider()

  async function addEntity(e: EntityInput): Promise<Entity> {
    assertEntityInput(e)
    logger.info('addEntity', { projectId: e.projectId, type: e.type })
    const stringContent = stringifyJsonValues(e.content)
    const embedding = await embeddingProvider.embed(stringContent)
    const out = await db.query(SQL.insertEntity, [
      e.projectId,
      e.type,
      e.content,
      stringContent,
      toVectorLiteral(embedding),
      e.metadata ?? null,
    ])
    return out.rows[0]
  }

  async function getEntityById(id: string): Promise<Entity | undefined> {
    logger.info('getEntityById', { id })
    const r = await db.query(SQL.getEntityById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row
  }

  async function updateEntity(id: string, patch: EntityPatch): Promise<Entity | undefined> {
    assertEntityPatch(patch)
    logger.info('updateEntity', { id, keys: Object.keys(patch) })
    const exists = await getEntityById(id)
    if (!exists) return

    let embeddingLiteral = null
    let newContent = null
    let newContentString = null

    if (patch.content !== undefined) {
      newContent = patch.content
      newContentString = stringifyJsonValues(patch.content)
      const emb = await embeddingProvider.embed(newContentString)
      embeddingLiteral = toVectorLiteral(emb)
    }

    const r = await db.query(SQL.updateEntity, [
      id,
      patch.type ?? null,
      newContent,
      newContentString,
      embeddingLiteral,
      patch.metadata ?? null,
    ])
    const row = r.rows[0]
    if (!row) return undefined
    return row
  }

  async function deleteEntity(id: string): Promise<boolean> {
    logger.info('deleteEntity', { id })
    const r = await db.query(SQL.deleteEntity, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function searchEntities(params: SearchParams): Promise<EntityWithScore[]> {
    assertSearchParams(params)
    logger.info('searchEntities', params)
    const rawQuery = (params.query ?? '').trim()
    if (rawQuery.length <= 0) return []

    const query = prepareQuery(rawQuery)
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5)) / 2
    const keywordWeight = textWeight
    const semWeight = 1 - (textWeight + keywordWeight)
    const limit = Math.max(1, Math.min(1000, params.limit ?? 20))

    const filter: { types?: string[]; ids?: string[]; projectIds?: string[] } = {}
    if (params.types && params.types.length > 0) filter.types = params.types
    if (params.ids && params.ids.length > 0) filter.ids = params.ids
    if (params.projectIds && params.projectIds.length > 0) filter.projectIds = params.projectIds

    const r = await db.query(SQL.searchEntitiesQuery, [
      query,
      qvec,
      limit,
      Object.keys(filter).length ? JSON.stringify(filter) : JSON.stringify({}),
      textWeight,
      keywordWeight,
      semWeight,
      50,
    ])
    return r.rows
  }

  async function matchEntities(
    criteria: any | undefined,
    options?: MatchParams,
  ): Promise<Entity[]> {
    assertMatchParams(options)
    logger.info('matchEntities', {
      criteria,
      options,
    })

    const filter: { types?: string[]; ids?: string[]; projectIds?: string[] } = {}
    if (options?.types && options.types.length > 0) filter.types = options.types
    if (options?.ids && options.ids.length > 0) filter.ids = options.ids
    if (options?.projectIds && options.projectIds.length > 0) filter.projectIds = options.projectIds

    const limit = Math.max(1, Math.min(1000, options?.limit ?? 20))
    const r = await db.query(SQL.matchEntities, [
      JSON.stringify(criteria ?? {}),
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])
    return r.rows
  }

  async function clearEntities(projectIds?: string[]): Promise<void> {
    logger.info('clearEntities', { count: projectIds?.length || 0 })
    if (projectIds && projectIds.length > 0) {
      await db.query(SQL.clearEntitiesByProject, [projectIds])
    } else {
      await db.query(SQL.clearEntities)
    }
  }

  // ---------------------
  // Documents (text)
  // ---------------------

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
      // const embeddings = await embeddingProvider.embedBatch(embInputs)

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
    // Check existence first to avoid unnecessary compute and to align with entity update behavior
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

    // Run hybrid search and direct name/src search in parallel
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

  async function searchDocumentsForKeywords(
    args: SearchDocumentsForKeywordsArgs,
  ): Promise<string[]> {
    assertSearchDocumentsForKeywordsArgs(args)
    logger.info('searchDocumentsForKeywords', args)

    const tokens = toTokens(args.keywords)
    if (tokens.length === 0) return []

    const includeNameAndSrc = args.includeNameAndSrc ?? true
    const limit = Math.max(1, Math.min(1000, args.limit ?? 20))
    const pathPrefix = normalizePathPrefix(args.pathPrefix)
    const escapedPrefix = pathPrefix ? escapeLikePattern(pathPrefix) : null

    // Use ranked keyword search (DB function). MatchMode is not supported in the ranked version yet.
    // We pass a single text query with space-separated tokens.
    const queryText = tokens.join(' ')

    const r = await db.query(SQL.keywordSearchDocumentsForPaths, [
      args.projectIds,
      queryText,
      escapedPrefix,
      includeNameAndSrc,
      limit,
    ])

    return (r.rows || []).map((row: any) => normalizeDocPath(row.src))
  }

  async function searchDocumentsForExact(args: SearchDocumentsForExactArgs): Promise<string[]> {
    assertSearchDocumentsForExactArgs(args)
    logger.info('searchDocumentsForExact', args)

    const tokens = toTokens(args.needles)
    if (tokens.length === 0) return []

    const limit = Math.max(1, Math.min(1000, args.limit ?? 20))
    const includeNameAndSrc = args.includeNameAndSrc ?? true
    const matchMode = args.matchMode ?? 'any'
    const caseSensitive = args.caseSensitive ?? true
    const pathPrefix = normalizePathPrefix(args.pathPrefix)
    const escapedPrefix = pathPrefix ? escapeLikePattern(pathPrefix) : null

    // Use ranked literal search (DB function). MatchMode is not supported in the ranked version yet.
    // We pass a single text query with space-separated needles.
    const queryText = tokens.join(' ')

    const r = await db.query(SQL.literalSearchDocumentsForPaths, [
      args.projectIds,
      queryText,
      escapedPrefix,
      includeNameAndSrc,
      caseSensitive,
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

  async function close(): Promise<void> {
    logger.info('close')
    try {
      await embeddingProvider.close?.()
    } catch {
      // ignore embedding provider close errors
    } finally {
      await db.end()
    }
  }

  return {
    addEntity,
    getEntityById,
    updateEntity,
    deleteEntity,
    searchEntities,
    matchEntities,
    clearEntities,

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

    close,
    raw: () => db,
  }
}

export type * from './types.js'

// Runtime lifecycle helpers (managed/external ephemeral DB)
export { createDatabase, destroyDatabase, createReusableDatabase } from './runtime.js'
export type { CreateDatabaseOptions } from './runtime.js'
export type { CreateReusableDatabaseOptions } from './runtime.js'
