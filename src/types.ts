export type OpenDbOptions = {
  connectionString: string
  logLevel?: LogLevel
}

// Documents (text)
export type Document = {
  id: string
  type: string
  content: string
  src: string
  createdAt: string
  updatedAt: string
  metadata?: string | null
}

export type DocumentInput = {
  type: string
  content: string
  src: string
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

// Logger
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type Logger = {
  debug: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};