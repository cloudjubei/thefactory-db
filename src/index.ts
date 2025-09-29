import { DB, openPostgres } from './connection.js'
import { createLogger } from './logger.js'
import type {
  SearchParams,
  Entity,
  EntityWithScore,
  EntityInput,
  OpenDbOptions,
  Document,
  DocumentInput,
  DocumentWithScore,
  EntityPatch,
  MatchParams,
  DocumentPatch,
} from './types.js'
import { createLocalEmbeddingProvider } from './utils/embeddings.js'
import { SQL } from './utils.js'
import { stringifyJsonValues } from './utils/json.js'
import {
  assertDocumentInput,
  assertDocumentPatch,
  assertEntityInput,
  assertEntityPatch,
  assertMatchParams,
  assertSearchParams,
} from './validation.js'

function toVectorLiteral(vec: number[] | Float32Array): string {
  // pgvector input format: '[1,2,3]'
  // Normalize numeric precision to avoid Float32 artifacts like 0.10000000149
  const nums = Array.from(vec).map((n) => {
    const rounded = Math.round(Number(n) * 1e6) / 1e6 // 6 decimal places is ample for pgvector input
    return Number.isFinite(rounded) ? rounded.toString() : '0'
  })
  return `[${nums.join(',')}]`
}

export interface TheFactoryDb {
  // Entities (json)
  addEntity(e: EntityInput): Promise<Entity>
  getEntityById(id: string): Promise<Entity | undefined>
  updateEntity(id: string, patch: EntityPatch): Promise<Entity | undefined>
  deleteEntity(id: string): Promise<boolean>
  searchEntities(params: SearchParams): Promise<EntityWithScore[]>
  matchEntities(criteria: any | undefined, options?: MatchParams): Promise<Entity[]>
  clearEntities(projectIds?: string[]): Promise<void>

  // Documents (text)
  addDocument(d: DocumentInput): Promise<Document>
  getDocumentById(id: string): Promise<Document | undefined>
  getDocumentBySrc(projectId: string, src: string): Promise<Document | undefined>
  upsertDocuments(inputs: Partial<DocumentInput>[]): Promise<Document[]>
  upsertDocument(input: Partial<DocumentInput>): Promise<Document | undefined>
  updateDocument(id: string, patch: Partial<DocumentInput>): Promise<Document | undefined>
  deleteDocument(id: string): Promise<boolean>
  searchDocuments(params: SearchParams): Promise<DocumentWithScore[]>
  matchDocuments(options: MatchParams): Promise<Document[]>
  clearDocuments(projectIds?: string[]): Promise<void>

  close(): Promise<void>
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
    return out.rows[0] as Entity
  }

  async function getEntityById(id: string): Promise<Entity | undefined> {
    logger.info('getEntityById', { id })
    const r = await db.query(SQL.getEntityById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row as Entity
  }

  async function updateEntity(id: string, patch: EntityPatch): Promise<Entity | undefined> {
    assertEntityPatch(patch)
    logger.info('updateEntity', { id, keys: Object.keys(patch) })
    const exists = await getEntityById(id)
    if (!exists) return

    let embeddingLiteral: string | null = null
    let newContent: unknown | null = null
    let newContentString: string | null = null

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
    return row as Entity
  }

  async function deleteEntity(id: string): Promise<boolean> {
    logger.info('deleteEntity', { id })
    const r = await db.query(SQL.deleteEntity, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function searchEntities(params: SearchParams): Promise<EntityWithScore[]> {
    assertSearchParams(params)
    logger.info('searchEntities', params)
    const query = (params.query ?? '').trim()
    if (query.length <= 0) return []
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5)) / 2
    const keywordWeight = textWeight
    const semWeight = 1 - (textWeight + keywordWeight)
    const limit = Math.max(1, Math.min(1000, params.limit ?? 20))

    const filter: any = {}
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

    return r.rows as EntityWithScore[]
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
    const filter: any = {}
    if (options?.types && options.types.length > 0) filter.types = options.types
    if (options?.ids && options.ids.length > 0) filter.ids = options.ids
    if (options?.projectIds && options.projectIds.length > 0) filter.projectIds = options.projectIds
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 20))

    const r = await db.query(SQL.matchEntities, [
      JSON.stringify(criteria ?? {}),
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])

    return r.rows as Entity[]
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
    const embedding = await embeddingProvider.embed(content)

    const out = await db.query(SQL.insertDocument, [
      d.projectId,
      d.type,
      d.src,
      d.name,
      content,
      toVectorLiteral(embedding),
      d.metadata ?? null,
    ])
    return out.rows[0] as Document
  }

  async function getDocumentById(id: string): Promise<Document | undefined> {
    const r = await db.query(SQL.getDocumentById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row as Document
  }

  async function getDocumentBySrc(projectId: string, src: string): Promise<Document | undefined> {
    const r = await db.query(SQL.getDocumentBySrc, [projectId, src])
    const row = r.rows[0]
    if (!row) return undefined
    return row as Document
  }

  async function upsertDocuments(inputs: Partial<DocumentInput>[]): Promise<Document[]> {
    if (!inputs || inputs.length === 0) {
      return []
    }
    logger.info(`upsertDocuments: a batch of ${inputs.length} documents`)

    // const contents = inputs.map(d => d.content ?? ''); //TODO: batch improvement
    // const embeddings = await embeddingProvider.embedBatch(contents); //TODO: batch improvement

    const upsertedDocs: Document[] = []

    try {
      await db.query('BEGIN')

      for (const input of inputs) {
        let embeddingLiteral: string | null = null
        let newContent: string | null = null

        if (input.content !== undefined) {
          // embeddingLiteral = toVectorLiteral(embeddings[i]) //TODO: batch improvement

          newContent = input.content ?? ''
          const emb = await embeddingProvider.embed(newContent)
          embeddingLiteral = toVectorLiteral(emb)
        }

        const result = await db.query(SQL.upsertDocument, [
          input.projectId ?? null,
          input.type ?? null,
          input.src ?? null,
          input.name ?? null,
          newContent,
          embeddingLiteral,
          input.metadata ?? null,
        ])

        // If a row was returned, it means it was inserted or updated
        if (result.rows[0]) {
          upsertedDocs.push(result.rows[0] as Document)
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
    } finally {
    }
  }

  async function upsertDocument(input: Partial<DocumentInput>): Promise<Document | undefined> {
    logger.info('upsertDocument', { src: input.src })

    let embeddingLiteral: string | null = null
    let newContent: string | null = null

    if (input.content !== undefined) {
      newContent = input.content ?? ''
      const emb = await embeddingProvider.embed(newContent)
      embeddingLiteral = toVectorLiteral(emb)
    }

    const result = await db.query(SQL.upsertDocument, [
      input.projectId ?? null,
      input.type ?? null,
      input.src ?? null,
      input.name ?? null,
      newContent,
      embeddingLiteral,
      input.metadata ?? null,
    ])

    const upsertedDocument = result.rows[0]

    if (upsertedDocument) {
      logger.info('Document was upserted', { src: input.src })
      return upsertedDocument as Document
    } else {
      logger.info('Skipped document update (content unchanged)', { src: input.src })
      return undefined
    }
  }

  async function updateDocument(id: string, patch: DocumentPatch): Promise<Document | undefined> {
    assertDocumentPatch(patch)
    logger.info('updateDocument', { id, name: patch.name })

    let embeddingLiteral: string | null = null
    let newContent: string | null = null

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
    return updatedDocument as Document
  }

  async function deleteDocument(id: string): Promise<boolean> {
    logger.info('deleteDocument', { id })
    const r = await db.query(SQL.deleteDocument, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function matchDocuments(options: {
    types?: string[]
    ids?: string[]
    projectIds?: string[]
    limit?: number
  }): Promise<Document[]> {
    assertMatchParams(options)
    logger.info('matchDocuments', options)
    const filter: any = {}
    if (options?.types && options.types.length > 0) filter.types = options.types
    if (options?.ids && options.ids.length > 0) filter.ids = options.ids
    if (options?.projectIds && options.projectIds.length > 0) filter.projectIds = options.projectIds
    const limit = Math.max(1, Math.min(1000, options?.limit ?? 20))

    const r = await db.query(SQL.matchDocuments, [
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])

    return r.rows as Document[]
  }

  async function searchDocuments(params: SearchParams): Promise<DocumentWithScore[]> {
    assertSearchParams(params)
    logger.info('searchDocuments', params)
    const query = (params.query ?? '').trim()
    if (query.length <= 0) return []
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5)) / 2
    const keywordWeight = textWeight
    const semWeight = 1 - (textWeight + keywordWeight)
    const limit = Math.max(1, Math.min(1000, params.limit ?? 20))

    const filter: any = {}
    if (params.types && params.types.length > 0) filter.types = params.types
    if (params.ids && params.ids.length > 0) filter.ids = params.ids
    if (params.projectIds && params.projectIds.length > 0) filter.projectIds = params.projectIds

    const r = await db.query(SQL.searchDocumentsQuery, [
      query,
      qvec,
      limit,
      Object.keys(filter).length ? JSON.stringify(filter) : JSON.stringify({}),
      textWeight,
      keywordWeight,
      semWeight,
      50,
    ])

    return r.rows as DocumentWithScore[]
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
    await db.end()
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
    close,
    // raw: () => db,
  }
}

export type * from './types.js'
