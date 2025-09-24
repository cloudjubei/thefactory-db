export function readSql(name: string): string | undefined {
  return SQLS[name];
}

export function base64ToUtf8(base64: string) {
  if (base64.startsWith('data:')) {
    const base64Data = base64.split(',')[1];
    return atob(base64Data);
  }
  return atob(base64);
}

// -----------------------------
// CRUD SQL for Entities (jsonb)
// -----------------------------
const deleteEntity = `DELETE FROM entities WHERE id = $1;`;

const getEntityById = `
SELECT 
  id,
  project_id AS "projectId",
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM entities
WHERE id = $1;
`;

const insertEntity = `
INSERT INTO entities (project_id, type, content, content_string, embedding, metadata)
VALUES ($1, $2, $3::jsonb, $4, $5::vector, $6::jsonb)
RETURNING 
  id,
  project_id AS "projectId",
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata;
`;

const updateEntity = `
UPDATE entities SET
  type = COALESCE($2, type),
  content = COALESCE($3::jsonb, content),
  content_string = COALESCE($4, content_string),
  embedding = COALESCE($5::vector, embedding),
  metadata = COALESCE($6::jsonb, metadata)
WHERE id = $1
RETURNING 
  id,
  project_id AS "projectId",
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata;
`;

// -------------------------------
// CRUD SQL for Documents (text)
// -------------------------------
const deleteDocument = `DELETE FROM documents WHERE id = $1;`;

const getDocumentById = `
SELECT 
  id,
  project_id AS "projectId",
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM documents
WHERE id = $1;
`;

const getDocumentBySrc = `
SELECT 
  id,
  project_id AS "projectId",
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM documents
WHERE src = $1;
`;

const insertDocument = `
INSERT INTO documents (project_id, type, content, src, embedding, metadata)
VALUES ($1, $2, $3, $4, $5::vector, $6::jsonb)
RETURNING 
  id,
  project_id AS "projectId",
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata;
`;

const updateDocument = `
UPDATE documents SET
  type = COALESCE($2, type),
  content = COALESCE($3, content),
  src = COALESCE($4, src),
  embedding = COALESCE($5::vector, embedding),
  metadata = COALESCE($6::jsonb, metadata)
WHERE id = $1
RETURNING 
  id,
  project_id AS "projectId",
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata;
`;

// ----------------------------------------------------------
// Schema: documents (text) and entities (jsonb), indexes and triggers
// ----------------------------------------------------------
const schema = `
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  type text NOT NULL,
  content text,
  fts tsvector GENERATED ALWAYS AS (
    CASE WHEN content IS NULL OR content = '' THEN NULL ELSE to_tsvector('english', content) END
  ) STORED,
  embedding vector(384),
  src text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Basic indexes for documents
CREATE INDEX IF NOT EXISTS documents_project_id_idx ON documents USING btree(project_id);
CREATE INDEX IF NOT EXISTS documents_type_idx ON documents USING btree(type);
CREATE INDEX IF NOT EXISTS documents_fts_idx ON documents USING GIN(fts);
-- Vector index HNSW preferred, fallback to IVFFLAT
DO $$
BEGIN
  EXECUTE 'CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx ON documents USING hnsw (embedding vector_cosine_ops)';
EXCEPTION WHEN undefined_object THEN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS documents_embedding_ivfflat_idx ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  EXCEPTION WHEN others THEN
    NULL;
  END;
END$$;

-- Trigger to update updated_at on row modification
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_set_updated_at ON documents;
CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Entities table
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  type text NOT NULL,
  content jsonb NOT NULL,
  content_string text NOT NULL,
  fts tsvector GENERATED ALWAYS AS (
    CASE WHEN content_string IS NULL OR content_string = '' THEN NULL ELSE to_tsvector('english', content_string) END
  ) STORED,
  embedding vector(384),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Updated_at trigger for entities (fts is a GENERATED column)
DROP TRIGGER IF EXISTS entities_set_updated_at ON entities;
CREATE TRIGGER entities_set_updated_at
BEFORE UPDATE ON entities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Indexes for entities
CREATE INDEX IF NOT EXISTS entities_project_id_idx ON entities USING btree(project_id);
CREATE INDEX IF NOT EXISTS entities_type_idx ON entities USING btree(type);
CREATE INDEX IF NOT EXISTS entities_fts_idx ON entities USING GIN(fts);
DO $$
BEGIN
  EXECUTE 'CREATE INDEX IF NOT EXISTS entities_embedding_hnsw_idx ON entities USING hnsw (embedding vector_cosine_ops)';
EXCEPTION WHEN undefined_object THEN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS entities_embedding_ivfflat_idx ON entities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  EXCEPTION WHEN others THEN
    NULL;
  END;
END$$;
`;

// ----------------------------------------------------------
// Hybrid search functions for documents and entities
// - Filters with jsonb: { ids: [uuid], types: [text], projectIds: [text] }
// ----------------------------------------------------------
const hybridSearch = `
-- Documents
CREATE OR REPLACE FUNCTION hybrid_search_documents(
  query_text        text,
  query_embedding   vector,
  match_count       integer,
  filter            jsonb DEFAULT '{}'::jsonb,
  full_text_weight  float  DEFAULT 0.5,
  semantic_weight   float  DEFAULT 0.5,
  rrf_k             integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  project_id text,
  type text,
  content text,
  src text,
  created_at timestamptz,
  updated_at timestamptz,
  metadata jsonb,
  rrf_score double precision,
  similarity float,
  cosine_similarity float,
  keyword_score float
)
LANGUAGE sql AS
$$
WITH tokens AS (
  SELECT token
  FROM unnest(regexp_split_to_array(trim(coalesce(query_text, '')), E'\\s+')) AS token
  WHERE length(token) > 0
),
base_documents AS (
  SELECT *
  FROM documents
  WHERE (
    (NOT filter ? 'ids') OR id = ANY (
      ARRAY(SELECT jsonb_array_elements_text(filter->'ids')::uuid)
    )
  )
  AND (
    (NOT filter ? 'types') OR type = ANY (
      ARRAY(SELECT jsonb_array_elements_text(filter->'types'))
    )
  )
  AND (
    (NOT filter ? 'projectIds') OR project_id = ANY (
      ARRAY(SELECT jsonb_array_elements_text(filter->'projectIds'))
    )
  )
),
token_scores AS (
  SELECT d.id,
         MAX(
           COALESCE(ts_rank_cd(d.fts, websearch_to_tsquery('english', t.token)), 0.0) * 0.5 +
           COALESCE(
             ts_rank_cd(
               to_tsvector('simple', regexp_replace(d.src, '[^a-zA-Z0-9]+', ' ', 'g')),
               websearch_to_tsquery('simple', t.token)
             ),
             0.0
           ) * 1.5
         ) AS token_max_score
  FROM base_documents d
  CROSS JOIN tokens t
  GROUP BY d.id
),
full_text AS (
  SELECT ts.id,
         row_number() OVER (
           ORDER BY ts.token_max_score DESC, ts.id ASC
         ) AS rank_ix
  FROM token_scores ts
  WHERE ts.token_max_score > 0
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT id,
         row_number() OVER (
           ORDER BY embedding <-> query_embedding, id ASC
         ) AS rank_ix
  FROM base_documents
  WHERE embedding IS NOT NULL
  LIMIT LEAST(match_count, 30) * 2
),
scored AS (
  SELECT COALESCE(ft.id, s.id) AS id,
         COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
         COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight AS rrf_score
  FROM full_text ft
  FULL JOIN semantic s ON ft.id = s.id
)
SELECT d.id,
       d.project_id,
       d.type,
       d.content,
       d.src,
       d.created_at,
       d.updated_at,
       d.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) AS similarity,
       CASE WHEN d.embedding IS NULL THEN NULL ELSE 1 - (d.embedding <-> query_embedding)::float END AS cosine_similarity,
       COALESCE(ts.token_max_score, 0.0) AS keyword_score
FROM scored
JOIN base_documents d ON d.id = scored.id
LEFT JOIN token_scores ts ON ts.id = d.id
ORDER BY similarity DESC, d.id ASC
LIMIT match_count;
$$;

-- Entities content
CREATE OR REPLACE FUNCTION hybrid_search_entities(
  query_text        text,
  query_embedding   vector,
  match_count       integer,
  filter            jsonb DEFAULT '{}'::jsonb,
  full_text_weight  float  DEFAULT 0.5,
  semantic_weight   float  DEFAULT 0.5,
  rrf_k             integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  project_id text,
  type text,
  content jsonb,
  created_at timestamptz,
  updated_at timestamptz,
  metadata jsonb,
  rrf_score double precision,
  similarity float,
  cosine_similarity float,
  keyword_score float
)
LANGUAGE sql AS
$$
WITH tokens AS (
  SELECT token
  FROM unnest(regexp_split_to_array(trim(coalesce(query_text, '')), E'\\s+')) AS token
  WHERE length(token) > 0
),
base_entities AS (
  SELECT *
  FROM entities
  WHERE (
    (NOT filter ? 'ids') OR id = ANY (
      ARRAY(SELECT jsonb_array_elements_text(filter->'ids')::uuid)
    )
  )
  AND (
    (NOT filter ? 'types') OR type = ANY (
      ARRAY(SELECT jsonb_array_elements_text(filter->'types'))
    )
  )
  AND (
    (NOT filter ? 'projectIds') OR project_id = ANY (
      ARRAY(SELECT jsonb_array_elements_text(filter->'projectIds'))
    )
  )
),
token_scores AS (
  SELECT e.id,
         MAX(COALESCE(ts_rank_cd(e.fts, websearch_to_tsquery('english', t.token)), 0.0)) AS token_max_score
  FROM base_entities e
  CROSS JOIN tokens t
  GROUP BY e.id
),
full_text AS (
  SELECT ts.id,
         row_number() OVER (
           ORDER BY ts.token_max_score DESC, ts.id ASC
         ) AS rank_ix
  FROM token_scores ts
  WHERE ts.token_max_score > 0
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT id,
         row_number() OVER (
           ORDER BY embedding <-> query_embedding, id ASC
         ) AS rank_ix
  FROM base_entities
  WHERE embedding IS NOT NULL
  LIMIT LEAST(match_count, 30) * 2
),
scored AS (
  SELECT COALESCE(ft.id, s.id) AS id,
         COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
         COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight AS rrf_score
  FROM full_text ft
  FULL JOIN semantic s ON ft.id = s.id
)
SELECT e.id,
       e.project_id,
       e.type,
       e.content,
       e.created_at,
       e.updated_at,
       e.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) AS similarity,
       CASE WHEN e.embedding IS NULL THEN NULL ELSE 1 - (e.embedding <-> query_embedding)::float END AS cosine_similarity,
       COALESCE(ts.token_max_score, 0.0) AS keyword_score
FROM scored
JOIN base_entities e ON e.id = scored.id
LEFT JOIN token_scores ts ON ts.id = e.id
ORDER BY similarity DESC, e.id ASC
LIMIT match_count;
$$;
`;

// ----------------------------------------------------------
// Search query wrappers calling hybrid_search_* functions
// ----------------------------------------------------------
const searchEntitiesQuery = `
SELECT
  id,
  project_id AS "projectId",
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata,
  keyword_score as "textScore",
  cosine_similarity as "vecScore",
  similarity as "totalScore"
FROM hybrid_search_entities($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::int);
`;

const searchDocumentsQuery = `
SELECT
  id,
  project_id AS "projectId",
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata,
  keyword_score as "textScore",
  cosine_similarity as "vecScore",
  similarity as "totalScore"
FROM hybrid_search_documents($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::int);
`;

// ----------------------------------------------------------
// Match entities by JSON content containment with filters
//   $1: jsonb pattern to match (content @> $1)
//   $2: jsonb filter { ids?: string[], types?: string[], projectIds?: string[] }
//   $3: int limit (optional)
// ----------------------------------------------------------
const matchEntities = `
SELECT
  id,
  project_id AS "projectId",
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM entities
WHERE content @> $1::jsonb
  AND (
    $2::jsonb IS NULL
    OR (
      (NOT ($2 ? 'ids') OR id = ANY (ARRAY(SELECT jsonb_array_elements_text($2->'ids')::uuid)))
      AND (NOT ($2 ? 'types') OR type = ANY (ARRAY(SELECT jsonb_array_elements_text($2->'types'))))
      AND (NOT ($2 ? 'projectIds') OR project_id = ANY (ARRAY(SELECT jsonb_array_elements_text($2->'projectIds'))))
    )
  )
ORDER BY updated_at DESC
LIMIT COALESCE($3::int, 100);
`;

// ----------------------------------------------------------
// Match documents by filters only (types/ids/projectIds)
//   $1: jsonb filter { ids?: string[], types?: string[], projectIds?: string[] } | null
//   $2: int limit (optional)
// ----------------------------------------------------------
const matchDocuments = `
SELECT
  id,
  project_id AS "projectId",
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM documents
WHERE (
  $1::jsonb IS NULL
  OR (
    (NOT ($1 ? 'ids') OR id = ANY (ARRAY(SELECT jsonb_array_elements_text($1->'ids')::uuid)))
    AND (NOT ($1 ? 'types') OR type = ANY (ARRAY(SELECT jsonb_array_elements_text($1->'types'))))
    AND (NOT ($1 ? 'projectIds') OR project_id = ANY (ARRAY(SELECT jsonb_array_elements_text($1->'projectIds'))))
  )
)
ORDER BY updated_at DESC
LIMIT COALESCE($2::int, 100);
`;

// Clear helpers
const clearDocuments = `TRUNCATE TABLE documents RESTART IDENTITY;`;
const clearEntities = `TRUNCATE TABLE entities RESTART IDENTITY;`;
const clearDocumentsByProject = `DELETE FROM documents WHERE project_id = ANY($1::text[]);`;
const clearEntitiesByProject = `DELETE FROM entities WHERE project_id = ANY($1::text[]);`;

const SQLS: Record<string, string> = {
  // Schema and functions
  schema: schema,
  hybridSearch: hybridSearch,

  // Entities
  deleteEntity: deleteEntity,
  getEntityById: getEntityById,
  insertEntity: insertEntity,
  updateEntity: updateEntity,
  searchEntitiesQuery: searchEntitiesQuery,
  matchEntities: matchEntities,
  clearEntities: clearEntities,
  clearEntitiesByProject: clearEntitiesByProject,

  // Documents
  deleteDocument: deleteDocument,
  getDocumentById: getDocumentById,
  getDocumentBySrc: getDocumentBySrc,
  insertDocument: insertDocument,
  updateDocument: updateDocument,
  searchDocumentsQuery: searchDocumentsQuery,
  matchDocuments: matchDocuments,
  clearDocuments: clearDocuments,
  clearDocumentsByProject: clearDocumentsByProject,
};
