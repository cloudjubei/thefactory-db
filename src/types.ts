/**
 * Options for opening a database connection.
 */
export type OpenDbOptions = {
  /** The PostgreSQL connection string. */
  connectionString: string
  /** The desired logging level. */
  logLevel?: LogLevel
}

// Documents (text)
/**
 * Represents a text-based document in the database.
 */
export type Document = {
  id: string
  projectId: string
  type: string
  name: string
  content: string
  src: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, any>
}

/**
 * Input for creating a new document.
 */
export type DocumentInput = {
  projectId: string
  type: string
  src: string
  name: string
  content: string
  metadata?: Record<string, any>
}
export type DocumentUpsertInput = DocumentInput & Pick<DocumentInput, 'content' | 'src'>

export type DocumentPatch = Omit<Partial<DocumentInput>, 'projectId'>

/**
 * A document augmented with search relevance scores.
 */
export type DocumentWithScore = Document & {
  /** The relevance score from full-text keyword search. */
  keywordScore: number | null
  /** The relevance score from full-text direct-match search. */
  textScore: number | null
  /** The relevance score from vector similarity search. */
  vecScore: number | null
  /** The combined total relevance score. */
  totalScore: number
}

// Entities (json)
/**
 * Represents a JSON-based entity in the database.
 */
export type Entity = {
  id: string
  projectId: string
  type: string
  content: unknown
  createdAt: string
  updatedAt: string
  metadata?: Record<string, any>
}

/**
 * Input for creating a new entity.
 */
export type EntityInput = {
  projectId: string
  type: string
  content: Record<string, any> | any[]
  metadata?: Record<string, any>
}

/**
 * Represents a patch for updating an entity. `projectId` cannot be changed.
 */
export type EntityPatch = Omit<Partial<EntityInput>, 'projectId'>

/**
 * An entity augmented with search relevance scores.
 */
export type EntityWithScore = Entity & {
  /** The relevance score from full-text keyword search. */
  keywordScore: number | null
  /** The relevance score from full-text direct-match search. */
  textScore: number | null
  /** The relevance score from vector similarity search. */
  vecScore: number | null
  /** The combined total relevance score. */
  totalScore: number
}

/**
 * Parameters for filtering results in match and search operations.
 */
export type MatchParams = {
  /** The maximum number of results to return. */
  limit?: number
  /** An array of types to filter by. */
  types?: string[]
  /** An array of IDs to filter by. */
  ids?: string[]
  /** An array of project IDs to filter by. */
  projectIds?: string[]
}

/**
 * Parameters for performing a hybrid search.
 */
export type SearchParams = MatchParams & {
  /** The search query string. */
  query: string
  /** The weight to give to full-text search score vs. vector search score (0.0 to 1.0). */
  textWeight?: number
}

// Logger
/**
 * Defines the available logging levels.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent'

/**
 * A simple logger interface.
 */
export type Logger = {
  debug: (...args: any[]) => void
  info: (...args: any[]) => void
  warn: (...args: any[]) => void
  error: (...args: any[]) => void
}
