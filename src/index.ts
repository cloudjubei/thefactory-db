import { openPostgres } from './connection.js'
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
} from './types.js'
import { createLocalEmbeddingProvider } from './utils/embeddings.js'
import { readSql } from './utils.js'
import { stringifyJsonValues } from './utils/json.js'

function toVectorLiteral(vec: number[] | Float32Array): string {
  // pgvector input format: '[1,2,3]'
  return `[${Array.from(vec).join(',')}]`
}

const SQL = {
  insert: readSql('insert_entity')!,
  getById: readSql('get_entity_by_id')!,
  deleteById: readSql('delete_entity')!,
  update: readSql('update_entity')!,
  searchEntities: readSql('search_entities_query')!,
  matchEntities: readSql('match_entities')!,
  clearEntities: readSql('clear_entities')!,
}

const SQL_DOCS = {
  insert: readSql('insert_document')!,
  getById: readSql('get_document_by_id')!,
  deleteById: readSql('delete_document')!,
  update: readSql('update_document')!,
  searchDocuments: readSql('search_documents_query')!,
  clearDocuments: readSql('clear_documents')!,
}

export interface TheFactoryDb {
  // Entities (json)
  addEntity(e: EntityInput): Promise<Entity>
  getEntityById(id: string): Promise<Entity | undefined>
  updateEntity(id: string, patch: Partial<EntityInput>): Promise<Entity | undefined>
  deleteEntity(id: string): Promise<boolean>
  searchEntities(params: SearchParams): Promise<EntityWithScore[]>
  matchEntities(criteria: unknown, options?: { types?: string[]; ids?: string[]; limit?: number }): Promise<Entity[]>
  clearEntities() : Promise<void>

  // Documents (text)
  addDocument(d: DocumentInput): Promise<Document>
  getDocumentById(id: string): Promise<Document | undefined>
  updateDocument(id: string, patch: Partial<DocumentInput>): Promise<Document | undefined>
  deleteDocument(id: string): Promise<boolean>
  searchDocuments(params: SearchParams): Promise<DocumentWithScore[]>
  clearDocuments() : Promise<void>

  close(): Promise<void>
}

export async function openDatabase({ connectionString, logLevel }: OpenDbOptions): Promise<TheFactoryDb> {
  const logger = createLogger(logLevel)
  const db = await openPostgres(connectionString)
  const embeddingProvider = await createLocalEmbeddingProvider()

  // ---------------------
  // Entities (json)
  // ---------------------
  async function addEntity(e: EntityInput): Promise<Entity> {
    logger.info('addEntity', { type: e.type })
    const stringContent = stringifyJsonValues(e.content)
    const embedding = await embeddingProvider.embed(stringContent)

    const out = await db.query(SQL.insert, [
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
    const r = await db.query(SQL.getById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row as Entity
  }

  async function updateEntity(
    id: string,
    patch: Partial<EntityInput>,
  ): Promise<Entity | undefined> {
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

    await db.query(SQL.update, [
      id,
      patch.type ?? null,
      newContent,
      newContentString,
      embeddingLiteral,
      patch.metadata ?? null,
    ])
    return await getEntityById(id)
  }

  async function deleteEntity(id: string): Promise<boolean> {
    logger.info('deleteEntity', { id })
    const r = await db.query(SQL.deleteById, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function searchEntities(params: SearchParams): Promise<EntityWithScore[]> {
    logger.info('searchEntities', { query: params.query, types: params.types?.length, ids: params.ids?.length })
    const query = (params.query ?? '').trim()
    if (query.length <= 0) return []
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5))
    const semWeight = 1 - textWeight
    const limit = Math.max(1, Math.min(1000, params.limit ?? 20))

    const filter: any = {}
    if (params.types && params.types.length > 0) filter.types = params.types
    if (params.ids && params.ids.length > 0) filter.ids = params.ids

    const r = await db.query(SQL.searchEntities, [
      query,
      qvec,
      limit,
      Object.keys(filter).length ? JSON.stringify(filter) : JSON.stringify({}),
      textWeight,
      semWeight,
      50,
    ])

    return r.rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content ?? null,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
      metadata: row.metadata ?? null,
      text_score: row.text_score ?? null,
      vec_score: row.vec_score ?? null,
      total_score: row.total_score ?? 0,
    }))
  }

  async function matchEntities(
    criteria: unknown,
    options?: { types?: string[]; ids?: string[]; limit?: number },
  ): Promise<Entity[]> {
    logger.info('matchEntities', { criteria, types: options?.types?.length, ids: options?.ids?.length })
    const filter: any = {}
    if (options?.types && options.types.length > 0) filter.types = options.types
    if (options?.ids && options.ids.length > 0) filter.ids = options.ids
    const limit = options?.limit ?? 100

    const r = await db.query(SQL.matchEntities, [
      JSON.stringify(criteria ?? {}),
      Object.keys(filter).length ? JSON.stringify(filter) : null,
      limit,
    ])

    return r.rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content ?? null,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
      metadata: row.metadata ?? null,
    }))
  }

  async function clearEntities(): Promise<void> {
    logger.info('clearEntities')
    await db.query(SQL.clearEntities)
  }

  // ---------------------
  // Documents (text)
  // ---------------------
  async function addDocument(d: DocumentInput): Promise<Document> {
    logger.info('addDocument', { type: d.type })
    const content = d.content ?? ''
    const embedding = await embeddingProvider.embed(content)

    const out = await db.query(SQL_DOCS.insert, [
      d.type,
      content,
      d.src,
      toVectorLiteral(embedding),
      d.metadata ?? null,
    ])
    return out.rows[0] as Document
  }

  async function getDocumentById(id: string): Promise<Document | undefined> {
    logger.info('getDocumentById', { id })
    const r = await db.query(SQL_DOCS.getById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return row as Document
  }

  async function updateDocument(
    id: string,
    patch: Partial<DocumentInput>,
  ): Promise<Document | undefined> {
    logger.info('updateDocument', { id, keys: Object.keys(patch) })
    const exists = await getDocumentById(id)
    if (!exists) return

    let embeddingLiteral: string | null = null
    let newContent: string | null = null

    if (patch.content !== undefined) {
      newContent = patch.content ?? ''
      const emb = await embeddingProvider.embed(newContent)
      embeddingLiteral = toVectorLiteral(emb)
    }

    await db.query(SQL_DOCS.update, [
      id,
      patch.type ?? null,
      newContent,
      patch.src ?? null,
      embeddingLiteral,
      patch.metadata ?? null,
    ])
    return await getDocumentById(id)
  }

  async function deleteDocument(id: string): Promise<boolean> {
    logger.info('deleteDocument', { id })
    const r = await db.query(SQL_DOCS.deleteById, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function searchDocuments(params: SearchParams): Promise<DocumentWithScore[]> {
    logger.info('searchDocuments', { query: params.query, types: params.types?.length, ids: params.ids?.length })
    const query = (params.query ?? '').trim()
    if (query.length <= 0) return []
    const qvecArr = await embeddingProvider.embed(query)
    const qvec = toVectorLiteral(qvecArr)
    const textWeight = Math.min(1, Math.max(0, params.textWeight ?? 0.5))
    const semWeight = 1 - textWeight
    const limit = Math.max(1, Math.min(1000, params.limit ?? 20))

    const filter: any = {}
    if (params.types && params.types.length > 0) filter.types = params.types
    if (params.ids && params.ids.length > 0) filter.ids = params.ids

    const r = await db.query(SQL_DOCS.searchDocuments, [
      query,
      qvec,
      limit,
      Object.keys(filter).length ? JSON.stringify(filter) : JSON.stringify({}),
      textWeight,
      semWeight,
      50,
    ])

    return r.rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content,
      src: row.src,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
      metadata: row.metadata ?? null,
      text_score: row.text_score ?? null,
      vec_score: row.vec_score ?? null,
      total_score: row.total_score ?? 0,
    }))
  }

  async function clearDocuments(): Promise<void> {
    logger.info('clearDocuments')
    await db.query(SQL_DOCS.clearDocuments)
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
    updateDocument,
    deleteDocument,
    searchDocuments,
    clearDocuments,
    close,
  }
}

export type { Entity, EntityWithScore } from './types.js'
export type { Document, DocumentWithScore } from './types.js'
