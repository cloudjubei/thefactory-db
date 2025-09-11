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

export interface OpenDbOptions {
  connectionString: string; // PostgreSQL connection string
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
