import { openPostgres } from './connection.js'
import type { SearchParams, Entity, EntityWithScore, EntityInput, OpenDbOptions } from './types.js'
import type { DB } from './connection.js'
import { v4 as uuidv4 } from 'uuid'
import { createLocalEmbeddingProvider } from './utils/embeddings.js'
import { readSql } from './utils.js'

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
}

export interface TheFactoryDb {
  addEntity(e: EntityInput): Promise<Entity>
  getEntityById(id: string): Promise<Entity | undefined>
  updateEntity(id: string, patch: Partial<EntityInput>): Promise<Entity | undefined>
  deleteEntity(id: string): Promise<boolean>
  searchEntities(params: SearchParams): Promise<EntityWithScore[]>
  raw(): DB
  close(): Promise<void>
}

export async function openDatabase({ connectionString }: OpenDbOptions): Promise<TheFactoryDb> {
  const db = await openPostgres(connectionString)

  async function addEntity(e: EntityInput): Promise<Entity> {
    const createdAt = nowIso()
    const content = e.content ?? ''
    const embedding = await embeddingProvider.embed(content)

    const id = uuidv4()
    await db.query(SQL.insert, [
      id,
      e.type,
      content,
      toVectorLiteral(embedding),
      createdAt,
      createdAt,
      e.metadata ?? null,
    ])
    // Return normalized entity
    return (await getEntityById(id)) as Entity
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
    let newContent: string | null = null

    if (patch.content !== undefined) {
      newContent = patch.content
      const emb = await embeddingProvider.embed(patch.content ?? '')
      embeddingLiteral = toVectorLiteral(emb)
    }

    await db.query(SQL.update, [
      id,
      patch.type ?? null,
      newContent ?? null,
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

    const typesArray = params.types && params.types.length > 0 ? params.types : null
    const r = await db.query(SQL.searchEntities, [query, qvec, limit, typesArray, textWeight, semWeight, 50])

    return r.rows.map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content ?? null,
      tokenized_content: row.tokenized_content ?? null,
      embedding: row.embedding ?? null,
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
    addEntity,
    getEntityById,
    updateEntity,
    deleteEntity,
    searchEntities,
    raw: () => db,
    close,
  }
}

export type { Entity, EntityWithScore } from './types.js'
