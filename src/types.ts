export type OpenDbOptions = {
  connectionString: string
}

// Documents (text)
export type Document = {
  id: string
  type: string
  content: string | null
  createdAt: string
  updatedAt: string
  metadata?: string | null
}

export type DocumentInput = {
  type: string
  content?: string
  metadata?: string | null
}

export type DocumentWithScore = Document & {
  text_score: number | null
  vec_score: number | null
  total_score: number
}

// Entities (json)
export type Entity = {
  id: string
  type: string
  content: unknown
  createdAt: string
  updatedAt: string
  metadata?: string | null
}

export type EntityInput = {
  type: string
  content: Record<string,any> | any[]
  metadata?: string | null
}

export type EntityWithScore = Entity & {
  text_score: number | null
  vec_score: number | null
  total_score: number
}

export type SearchParams = {
  query: string
  textWeight?: number
  limit?: number
  types?: string[]
  ids?: string[]
}
