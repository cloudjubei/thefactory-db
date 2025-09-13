export type EntityType = 'project_file' | 'internal_document' | 'external_blob'

export interface Entity {
  id: string
  type: EntityType
  content: string | null
  createdAt: string // ISO
  updatedAt: string // ISO
  metadata?: string | null // JSON-encoded object
}
export interface EntityFull extends Entity {
  fts: string | null
  embedding: string | null
}
export type EntityInput = {
  type: EntityType
  content?: string
  metadata?: string | null
}

export interface SearchParams {
  query: string
  textWeight?: number // 0..1 (weight for text score)
  limit?: number
  types?: EntityType[]
}

export interface EntityWithScore extends Entity {
  text_score: number | null
  vec_score: number | null
  total_score: number
}

export interface OpenDbOptions {
  connectionString: string
}
