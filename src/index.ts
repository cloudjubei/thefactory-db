import { openPostgres } from './connection.js'
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
import type { DB } from './connection.js'
import { v4 as uuidv4 } from 'uuid'
import { createLocalEmbeddingProvider } from './utils/embeddings.js'
import { readSql } from './utils.js'
import { stringifyJsonValues } from './utils/json.js'

const embeddingProvider = createLocalEmbeddingProvider()

function toVectorLiteral(vec: number[] | Float32Array): string {
  // pgvector input format: '[1,2,3]'
  return `[${Array.from(vec).join(',')}]`
}

function nowIso() {
  return new Date().toISOString()
}

const SQL = {
  insert: readSql('insert_entity')!,
  getById: readSql('get_entity_by_id')!,
  deleteById: readSql('delete_entity')!,
  update: readSql('update_entity')!,
  searchEntities: readSql('search_entities_query')!,
  matchEntities: readSql('match_entities')!,
}

const SQL_DOCS = {
  insert: readSql('insert_document')!,
  getById: readSql('get_document_by_id')!,
  deleteById: readSql('delete_document')!,
  update: readSql('update_document')!,
  searchDocuments: readSql('search_documents_query')!,
}

export interface TheFactoryDb {
  // Entities (json)
  addEntity(e: EntityInput): Promise<Entity>
  getEntityById(id: string): Promise<Entity | undefined>
  updateEntity(id: string, patch: Partial<EntityInput>): Promise<Entity | undefined>
  deleteEntity(id: string): Promise<boolean>
  searchEntities(params: SearchParams): Promise<EntityWithScore[]>
  matchEntities(criteria: unknown, options?: { types?: string[]; ids?: string[]; limit?: number }): Promise<Entity[]>

  // Documents (text)
  addDocument(d: DocumentInput): Promise<Document>
  getDocumentById(id: string): Promise<Document | undefined>
  updateDocument(id: string, patch: Partial<DocumentInput>): Promise<Document | undefined>
  deleteDocument(id: string): Promise<boolean>
  searchDocuments(params: SearchParams): Promise<DocumentWithScore[]>

  raw(): DB
  close(): Promise<void>
}

export async function openDatabase({ connectionString }: OpenDbOptions): Promise<TheFactoryDb> {
  const db = await openPostgres(connectionString)

  // ---------------------
  // Entities (json)
  // ---------------------
  async function addEntity(e: EntityInput): Promise<Entity> {
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
    const r = await db.query(SQL.getById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return {
      id: row.id,
      type: row.type,
      content: row.content ?? null,
      createdAt: row.createdAt ?? row.created_at ?? nowIso(),
      updatedAt: row.updatedAt ?? row.updated_at ?? nowIso(),
      metadata: row.metadata ?? null,
    }
  }

  async function updateEntity(
    id: string,
    patch: Partial<EntityInput>,
  ): Promise<Entity | undefined> {
    const exists = await getEntityById(id)
    if (!exists) return
    const updatedAt = nowIso()

    let embeddingLiteral: string | null = null
    let newContent: unknown | null = null

    if (patch.content !== undefined) {
      newContent = patch.content
      const embText = stringifyJsonValues(patch.content)
      const emb = await embeddingProvider.embed(embText)
      embeddingLiteral = toVectorLiteral(emb)
    }

    await db.query(SQL.update, [
      id,
      patch.type ?? null,
      newContent,
      embeddingLiteral,
      updatedAt,
      patch.metadata ?? null,
    ])
    return await getEntityById(id)
  }

  async function deleteEntity(id: string): Promise<boolean> {
    const r = await db.query(SQL.deleteById, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function searchEntities(params: SearchParams): Promise<EntityWithScore[]> {
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

  // ---------------------
  // Documents (text)
  // ---------------------
  async function addDocument(d: DocumentInput): Promise<Document> {
    const content = d.content ?? ''
    const embedding = await embeddingProvider.embed(content)

    const out = await db.query(SQL_DOCS.insert, [
      d.type,
      content,
      toVectorLiteral(embedding),
      d.metadata ?? null,
    ])
    return out.rows[0] as Document
  }

  async function getDocumentById(id: string): Promise<Document | undefined> {
    const r = await db.query(SQL_DOCS.getById, [id])
    const row = r.rows[0]
    if (!row) return undefined
    return {
      id: row.id,
      type: row.type,
      content: row.content ?? null,
      createdAt: row.createdAt ?? row.created_at ?? nowIso(),
      updatedAt: row.updatedAt ?? row.updated_at ?? nowIso(),
      metadata: row.metadata ?? null,
    }
  }

  async function updateDocument(
    id: string,
    patch: Partial<DocumentInput>,
  ): Promise<Document | undefined> {
    const exists = await getDocumentById(id)
    if (!exists) return
    const updatedAt = nowIso()

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
      embeddingLiteral,
      updatedAt,
      patch.metadata ?? null,
    ])
    return await getDocumentById(id)
  }

  async function deleteDocument(id: string): Promise<boolean> {
    const r = await db.query(SQL_DOCS.deleteById, [id])
    return (r.rowCount ?? 0) > 0
  }

  async function searchDocuments(params: SearchParams): Promise<DocumentWithScore[]> {
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
      content: row.content ?? null,
      createdAt: row.createdAt ?? row.created_at,
      updatedAt: row.updatedAt ?? row.updated_at,
      metadata: row.metadata ?? null,
      text_score: row.text_score ?? null,
      vec_score: row.vec_score ?? null,
      total_score: row.total_score ?? 0,
    }))
  }

  async function close(): Promise<void> {
    await db.end()
  }

  return {
    // entities
    addEntity,
    getEntityById,
    updateEntity,
    deleteEntity,
    searchEntities,
    matchEntities,
    // documents
    addDocument,
    getDocumentById,
    updateDocument,
    deleteDocument,
    searchDocuments,
    raw: () => db,
    close,
  }
}

export type { Entity, EntityWithScore } from './types.js'
export type { Document, DocumentWithScore } from './types.js'
