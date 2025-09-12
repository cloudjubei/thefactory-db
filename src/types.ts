export type EntityType = 'project_file' | 'internal_document' | 'external_blob';

export interface Entity {
  id: string;
  type: EntityType;
  content: string | null;
  // tokenized_content is not stored in Postgres schema; return null for compatibility
  tokenized_content: string | null;
  // embedding is stored as pgvector on DB; we return null or a string representation if needed
  embedding: string | null;
  createdAt: string; // ISO
  updatedAt: string; // ISO
  metadata?: string | null; // JSON-encoded object
}
export type EntityInput = {
  type: EntityType;
  content?: string;
  metadata?: string | null;
};

/**
 * OpenDbOptions controls how the database is opened.
 * - If `connectionString` is provided, the client will connect to that Postgres instance.
 * - If `databaseDir` is provided (or omitted to use a sensible default), the client will
 *   start or reuse a local embedded PostgreSQL instance using that directory for data.
 *
 * Note: Implementation of the local runtime is handled elsewhere; this type only expresses
 * the contract. If neither is provided, callers should expect the implementation to default
 * to using a local embedded PostgreSQL with a default data directory path inside the project
 * (e.g., ./.thefactory-db/pgdata), though the exact default may vary by implementation.
 */
export interface OpenDbOptions {
  /** Optional PostgreSQL connection string to connect to an existing server */
  connectionString?: string;
  /** Optional filesystem path to store the local PostgreSQL data directory. If omitted, a default path will be used by the implementation. */
  databaseDir?: string;
}

export interface SearchParams {
  query: string;
  textWeight?: number; // 0..1 (weight for text score)
  limit?: number;
  types?: EntityType[];
}

export interface EntityWithScore extends Entity {
  text_score: number | null;
  vec_score: number | null;
  total_score: number;
}
