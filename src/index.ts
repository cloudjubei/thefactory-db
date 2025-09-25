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
} from './types.js'
import { createLocalEmbeddingProvider } from './utils/embeddings.js'
import { readSql } from './utils.js'
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

// Lazily resolve SQL strings at call time so tests can mock readSql reliably
const SQL = {
  insert: () => readSql('insertEntity')!,
  getById: () => readSql('getEntityById')!,
  deleteById: () => readSql('deleteEntity')!,
  update: () => readSql('updateEntity')!,
  searchEntities: () => readSql('searchEntitiesQuery')!,
  matchEntities: () => readSql('matchEntities')!,
  clearEntities: () => readSql('clearEntities')!,
  clearEntitiesByProject: () => readSql('clearEntitiesByProject')!,
}

const SQL_DOCS = {
  insert: () => readSql('insertDocument')!,
  getById: () => readSql('getDocumentById')!,
  getBySrc: () => readSql('getDocumentBySrc')!,
  deleteById: () => readSql('deleteDocument')!,
  update: () => readSql('updateDocument')!,
  searchDocuments: () => readSql('searchDocumentsQuery')!,
  matchDocuments: () => readSql('matchDocuments')!,
  clearDocuments: () => readSql('clearDocuments')!,
  clearDocumentsByProject: () => readSql('clearDocumentsByProject')!,
}

/**
 * The main database interface for interacting with documents and entities.
 */
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
  getDocumentBySrc(src: string): Promise<Document | undefined>
  updateDocument(id: string, patch: Partial<DocumentInput>): Promise<Document | undefined>
  deleteDocument(id: string): Promise<boolean>
  searchDocuments(params: SearchParams): Promise<DocumentWithScore[]>
  matchDocuments(options: MatchParams): Promise<Document[]>
  clearDocuments(projectIds?: string[]): Promise<void>

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

    const out = await db.query(SQL.insert(), [
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
    const r = await db.query(SQL.getById(), [id])
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

    const r = await db.query(SQL.update(), [
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
    const r = await db.query(SQL.deleteById(), [id])
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

    const r = await db.query(SQL.searchEntities(), [
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

    const r = await db.query(SQL.matchEntities(), [
      JSON.stringify(criteria ?? {}),
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])

    return r.rows as Entity[]
  }

  async function clearEntities(projectIds?: string[]): Promise<void> {
    logger.info('clearEntities', { count: projectIds?.length || 0 })
    if (projectIds && projectIds.length > 0) {
      await db.query(SQL.clearEntitiesByProject(), [projectIds])
    } else {
      await db.query(SQL.clearEntities())
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

    const out = await db.query(SQL_DOCS.insert(), [
      d.projectId,
      d.type,
      d.name,
      content,
      d.src,
      toVectorLiteral(embedding),
      d.metadata ?? null,
    ])
    return out.rows[0] as Document
  }

  async function getDocumentById(id: string): Promise<Document | undefined> {
    const r = await db.query(SQL_DOCS.getById(), [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row as Document
  }

  async function getDocumentBySrc(src: string): Promise<Document | undefined> {
    const r = await db.query(SQL_DOCS.getBySrc(), [src])
    const row = r.rows[0]
    if (!row) return undefined
    return row as Document
  }

  async function updateDocument(
    id: string,
    patch: Partial<DocumentInput>,
  ): Promise<Document | undefined> {
    assertDocumentPatch(patch)
    logger.info('updateDocument', { id, name: patch.name, projectId: patch.projectId })

    let embeddingLiteral: string | null = null
    let newContent: string | null = null

    if (patch.content !== undefined) {
      newContent = patch.content ?? ''
      const emb = await embeddingProvider.embed(newContent)
      embeddingLiteral = toVectorLiteral(emb)
    }

    const r = await db.query(SQL_DOCS.update(), [
      id,
      patch.type ?? null,
      patch.name ?? null,
      newContent,
      patch.src ?? null,
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
    const r = await db.query(SQL_DOCS.deleteById(), [id])
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

    const r = await db.query(SQL_DOCS.matchDocuments(), [
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

    const r = await db.query(SQL_DOCS.searchDocuments(), [
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
      await db.query(SQL_DOCS.clearDocumentsByProject(), [projectIds])
    } else {
      await db.query(SQL_DOCS.clearDocuments())
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
    updateDocument,
    deleteDocument,
    searchDocuments,
    matchDocuments,
    clearDocuments,
    close,
    raw: () => db,
  }
}

export type * from './types.js'
