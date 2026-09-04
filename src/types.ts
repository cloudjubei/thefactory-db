/**
 * Options for opening a database connection.
 */
export type OpenDbOptions = {
  /** The PostgreSQL connection string. */
  connectionString: string
  /** The desired logging level. */
  logLevel?: LogLevel
  /**
   * Migration options.
   * - 'auto' (default): Automatically run pending migrations up to the latest version.
   * - 'none': Do not run any migrations.
   * - { toVersion: number }: Run migrations up to (or including) the specified version.
   */
  migrations?: 'auto' | 'none' | { toVersion?: number }
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
  contentHash: string
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
  shouldEmbed: boolean
  content: unknown
  externalKey?: string | null
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
  shouldEmbed?: boolean
  externalKey?: string | null
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

/** A comparison operator usable in an {@link EntityFieldPredicate}. */
export type EntityFilterOp = '<' | '<=' | '=' | '!=' | '>=' | '>' | 'contains' | 'exists'

/**
 * A predicate over a single field inside an entity's JSON `content`.
 *
 * `field` is a dot-path (e.g. `"metrics.total_return_pct"`); both the path and the value are sent
 * as bound parameters, never interpolated. Numeric operators (`<`,`<=`,`>=`,`>`) — and `=`/`!=`
 * when `value` is a number — only match rows where the field is a JSON number; a missing or
 * non-numeric field never matches. `exists` takes no `value`.
 */
export type EntityFieldPredicate = {
  field: string
  op: EntityFilterOp
  value?: string | number | boolean
}

/**
 * A composable boolean filter over entity content fields: a leaf {@link EntityFieldPredicate} or an
 * `and`/`or`/`not` composition of nested filters. Compiled to a parameterised SQL `WHERE` fragment.
 */
export type EntityFilter =
  | { and: EntityFilter[] }
  | { or: EntityFilter[] }
  | { not: EntityFilter }
  | EntityFieldPredicate

/** One ordering term over an entity content field (dot-path). */
export type EntitySort = {
  field: string
  direction?: 'asc' | 'desc'
  /** Compare numerically (cast to numeric, non-numbers sort last) rather than as text. */
  numeric?: boolean
}

/**
 * Parameters for filtering results in match and search operations.
 */
export type MatchParams = {
  /** The maximum number of results to return. */
  limit?: number
  /** Number of leading rows to skip — for stable, sorted pagination. */
  offset?: number
  /** An array of types to filter by. */
  types?: string[]
  /** An array of IDs to filter by. */
  ids?: string[]
  /** An array of project IDs to filter by. */
  projectIds?: string[]
  /** A composable predicate over entity content fields (numeric/text comparisons, and/or/not). */
  where?: EntityFilter
  /** Ordering terms over content fields; a stable `updated_at`/`id` tiebreak is always appended. */
  orderBy?: EntitySort[]
  /**
   * Content dot-paths to DROP from each returned row's `content`, applied in SQL via jsonb `#-` so the
   * (potentially huge) dropped subtrees are never read off the socket. Each path is a bound `text[]`
   * param — never interpolated. A list view can shed heavy per-row arrays (e.g. `"series"`,
   * `"artifacts.runChart"`) it never reads; siblings are kept. Non-object content passes through.
   */
  omit?: string[]
}

/**
 * Parameters for performing a hybrid search.
 */
export type SearchParams = MatchParams & {
  /** The search query string. */
  query: string
  /** The weight to give to full-text search score vs. vector search score (0.0 to 1.0). */
  textWeight?: number
  /**
   * How many candidate rows EACH ranked lane (full-text, semantic) may contribute before the
   * reciprocal-rank join. Defaults to 100 and is clamped to [1, 1000]; raise it when a collection is large
   * enough that the top 100 per signal no longer contains the right answer, at the cost of more work per
   * query. Below this ceiling the ranking degrades to raw substring count, which is why it is tunable.
   */
  candidateLimit?: number
}

// ------------------------------
// Improved document search APIs
// ------------------------------

export type DocumentSearchMatchMode = 'any' | 'all'

export type SearchDocumentsForPathsArgs = {
  projectIds: string[]
  query: string
  limit?: number
  pathPrefix?: string
}

export type SearchDocumentsForKeywordsArgs = {
  projectIds: string[]
  keywords: string | string[]
  matchMode?: DocumentSearchMatchMode // default: 'any'
  limit?: number
  pathPrefix?: string
}

export type SearchDocumentsForExactArgs = {
  projectIds: string[]
  needles: string | string[]
  matchMode?: DocumentSearchMatchMode // default: 'any'
  caseSensitive?: boolean // default: true
  limit?: number
  pathPrefix?: string
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

// ------------------------------
// Improved entity search APIs
// ------------------------------

export type EntitySearchMatchMode = 'any' | 'all'

export type SearchEntitiesForKeywordsArgs = {
  projectIds: string[]
  keywords: string | string[]
  matchMode?: EntitySearchMatchMode // default: 'any'
  /** Optional filter: only return entities with a type in this set. */
  types?: string[]
  limit?: number
}

export type SearchEntitiesForExactArgs = {
  projectIds: string[]
  needles: string | string[]
  matchMode?: EntitySearchMatchMode // default: 'any'
  caseSensitive?: boolean // default: true
  /** Optional filter: only return entities with a type in this set. */
  types?: string[]
  limit?: number
}
