const deleteEntity = `DELETE FROM entities WHERE id = $1;`

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
`

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
`

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
`

// -------------------------------
// CRUD SQL for Documents (text)
// -------------------------------
const deleteDocument = `DELETE FROM documents WHERE id = $1;`

const getDocumentById = `
SELECT 
  id,
  project_id AS "projectId",
  type,
  name,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM documents
WHERE id = $1;
`

const getDocumentBySrc = `
SELECT 
  id,
  project_id AS "projectId",
  type,
  name,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM documents
WHERE project_id = $1 AND src = $2;
`

const getChangingDocuments = `
WITH input_docs(src, content) AS (
  SELECT * FROM unnest($2::text[], $3::text[])
)
SELECT i.src
FROM input_docs i
LEFT JOIN documents d ON d.project_id = $1 AND d.src = i.src
WHERE d.id IS NULL OR d.content_hash IS DISTINCT FROM encode(digest(i.content, 'sha1'), 'hex');
`

const upsertDocument = `
INSERT INTO documents (project_id, type, src, name, content, embedding, metadata)
VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
ON CONFLICT (project_id, src)
DO UPDATE SET
  type = EXCLUDED.type,
  name = EXCLUDED.name,
  content = EXCLUDED.content,
  embedding = EXCLUDED.embedding,
  metadata = EXCLUDED.metadata,
  updated_at = now()
WHERE documents.content_hash IS DISTINCT FROM encode(digest(EXCLUDED.content, 'sha1'), 'hex')
RETURNING
  id,
  project_id AS "projectId",
  type,
  src,
  name,
  content,
  content_hash as "contentHash",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata;
`

const insertDocument = `
INSERT INTO documents (project_id, type, src, name, content, embedding, metadata)
VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
RETURNING 
  id,
  project_id AS "projectId",
  type,
  src,
  name,
  content,
  content_hash AS "contentHash",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata;
`

const updateDocument = `
UPDATE documents SET
  type = COALESCE($2, type),
  src = COALESCE($3, src),
  name = COALESCE($4, name),
  content = COALESCE($5, content),
  embedding = COALESCE($6::vector, embedding),
  metadata = COALESCE($7::jsonb, metadata)
WHERE id = $1
RETURNING 
  id,
  project_id AS "projectId",
  type,
  src,
  name,
  content,
  content_hash AS "contentHash",
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata;
`

// ----------------------------------------------------------
// Schema: documents (text) and entities (jsonb), indexes and triggers
// ----------------------------------------------------------
const schema = `
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE OR REPLACE FUNCTION tokenize_code(input_text text)
RETURNS text AS $$
BEGIN
  -- Convert camelCase and PascalCase to space-separated words
  input_text := regexp_replace(input_text, '([a-z])([A-Z])', '\\1 \\2', 'g');
  
  -- Replace underscores, hyphens, and dots with spaces
  input_text := regexp_replace(input_text, '[-._]', ' ', 'g');
  
  RETURN input_text;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL,
  type text NOT NULL,
  src text NOT NULL,
  name text NOT NULL,
  content text,
  content_hash text,
  fts tsvector GENERATED ALWAYS AS (
    to_tsvector('english', tokenize_code(name)) || to_tsvector('english', coalesce(tokenize_code(content), ''))
  ) STORED,
  embedding vector(384),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Basic indexes for documents
CREATE UNIQUE INDEX IF NOT EXISTS documents_project_src_unique_idx ON documents (project_id, src);
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

CREATE OR REPLACE FUNCTION set_document_content_hash()
RETURNS trigger AS $$
BEGIN
  -- Check if the content is new or has changed to avoid unnecessary computation
  IF NEW.content IS NOT NULL THEN
    NEW.content_hash = encode(digest(NEW.content, 'sha1'), 'hex');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS documents_set_content_hash ON documents;
CREATE TRIGGER documents_set_content_hash
BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION set_document_content_hash();

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
`

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
  literal_weight    float  DEFAULT 0.3,
  full_text_weight  float  DEFAULT 0.3,
  semantic_weight   float  DEFAULT 0.4,
  rrf_k             integer DEFAULT 50
)
RETURNS TABLE (
  id uuid,
  project_id text,
  type text,
  name text,
  content text,
  src text,
  created_at timestamptz,
  updated_at timestamptz,
  metadata jsonb,
  rrf_score double precision,
  similarity float,
  cosine_similarity float,
  keyword_score float,
  literal_score float
)
LANGUAGE sql AS
$$
WITH base_documents AS (
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
-- This CTE sanitizes the query for the full-text search
sanitized_query AS (
  SELECT regexp_replace(trim(coalesce(query_text, '')), '[^[:alnum:] ]+', '', 'g') AS cleaned_text
),
-- This CTE creates the OR-based tsquery from the sanitized text
or_ts_query AS (
  SELECT 
    CASE WHEN query_tokens.cleaned_text = '' THEN NULL ELSE to_tsquery('english', string_agg(lexeme, ' | ')) END AS ts_query
  FROM (
    SELECT t.cleaned_text, unnest(string_to_array(t.cleaned_text, ' ')) AS lexeme
    FROM sanitized_query t
  ) AS query_tokens
  WHERE lexeme <> ''
  GROUP BY query_tokens.cleaned_text
),
-- The CTE for the full-text (OR) search and ranking
token_scores AS (
  SELECT d.id, d.name, d.updated_at,
         ts_rank_cd(d.fts, t.ts_query) AS token_score
  FROM base_documents d
  CROSS JOIN or_ts_query t
  WHERE d.fts @@ t.ts_query
),
-- CTE for literal match counts and ranking
literal_search AS (
  SELECT d.id,
         COALESCE(SUM((LENGTH(d.content) - LENGTH(REPLACE(d.content, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) +
         COALESCE(SUM((LENGTH(d.name) - LENGTH(REPLACE(d.name, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) AS literal_count,
         row_number() OVER (ORDER BY (
            COALESCE(SUM((LENGTH(d.content) - LENGTH(REPLACE(d.content, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) +
            COALESCE(SUM((LENGTH(d.name) - LENGTH(REPLACE(d.name, t.lexeme, ''))) / LENGTH(t.lexeme)), 0)
         ) DESC) AS rank_ix
  FROM base_documents d
  CROSS JOIN (
    SELECT unnest(string_to_array(trim(coalesce(query_text, '')), ' ')) AS lexeme
  ) AS t
  WHERE LENGTH(t.lexeme) > 0
  GROUP BY d.id
),
-- Rank documents based on full-text score
full_text as (  
  SELECT ts.id,
    row_number() over (
      ORDER BY ts.token_score DESC, ts.name, ts.updated_at ASC
    ) as rank_ix
  FROM token_scores ts
  limit least(match_count, 30) * 2
),
-- Rank documents based on semantic similarity
semantic AS (
  SELECT id,
         row_number() OVER (
           ORDER BY embedding <#> query_embedding
         ) AS rank_ix
  FROM base_documents
  WHERE embedding IS NOT NULL
  LIMIT LEAST(match_count, 30) * 2
),
-- Combine ranks using RRF
scored AS (
  SELECT COALESCE(ft.id, s.id, ls.id) AS id,
         COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
         COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight +
         COALESCE(1.0 / (rrf_k + ls.rank_ix), 0.0) * literal_weight AS rrf_score
  FROM full_text ft
  FULL JOIN semantic s ON ft.id = s.id
  FULL JOIN literal_search ls ON ls.id = COALESCE(ft.id, s.id)
)
-- Final result with combined keyword score
SELECT d.id,
       d.project_id,
       d.type,
       d.name,
       d.content,
       d.src,
       d.created_at,
       d.updated_at,
       d.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight + literal_weight) / (rrf_k + 1)::float) AS similarity,
       COALESCE(1 - (embedding <=> query_embedding) / 2, 0) AS cosine_similarity,
       COALESCE(ts.token_score, 0.0) AS keyword_score,
       COALESCE(ls.literal_count, 0) AS literal_score
FROM scored
JOIN base_documents d ON d.id = scored.id
LEFT JOIN token_scores ts ON ts.id = d.id
LEFT JOIN literal_search ls ON ls.id = d.id
ORDER BY scored.rrf_score DESC, d.name ASC, d.updated_at DESC
LIMIT match_count;
$$;


-- Entities content
CREATE OR REPLACE FUNCTION hybrid_search_entities(
  query_text        text,
  query_embedding   vector,
  match_count       integer,
  filter            jsonb DEFAULT '{}'::jsonb,
  literal_weight    float  DEFAULT 0.3,
  full_text_weight  float  DEFAULT 0.3,
  semantic_weight   float  DEFAULT 0.4,
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
  keyword_score float,
  literal_score float
)
LANGUAGE sql AS
$$
WITH base_entities AS (
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
-- This CTE sanitizes the query for the full-text search
sanitized_query AS (
  SELECT regexp_replace(trim(coalesce(query_text, '')), '[^[:alnum:] ]+', '', 'g') AS cleaned_text
),
-- This CTE creates the OR-based tsquery from the sanitized text
or_ts_query AS (
  SELECT 
    CASE WHEN query_tokens.cleaned_text = '' THEN NULL ELSE to_tsquery('english', string_agg(lexeme, ' | ')) END AS ts_query
  FROM (
    SELECT t.cleaned_text, unnest(string_to_array(t.cleaned_text, ' ')) AS lexeme
    FROM sanitized_query t
  ) AS query_tokens
  WHERE lexeme <> ''
  GROUP BY query_tokens.cleaned_text
),
-- The CTE for the full-text (OR) search and ranking
token_scores AS (
  SELECT e.id, e.type, e.updated_at,
         ts_rank_cd(e.fts, t.ts_query) AS token_score
  FROM base_entities e
  CROSS JOIN or_ts_query t
  WHERE e.fts @@ t.ts_query
),
-- CTE for literal match counts and ranking
literal_search AS (
  SELECT e.id,
         COALESCE(SUM((LENGTH(e.content::text) - LENGTH(REPLACE(e.content::text, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) +
         COALESCE(SUM((LENGTH(e.type) - LENGTH(REPLACE(e.type, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) AS literal_count,
         row_number() OVER (ORDER BY (
            COALESCE(SUM((LENGTH(e.content::text) - LENGTH(REPLACE(e.content::text, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) +
            COALESCE(SUM((LENGTH(e.type) - LENGTH(REPLACE(e.type, t.lexeme, ''))) / LENGTH(t.lexeme)), 0)
         ) DESC) AS rank_ix
  FROM base_entities e
  CROSS JOIN (
    SELECT unnest(string_to_array(trim(coalesce(query_text, '')), ' ')) AS lexeme
  ) AS t
  WHERE LENGTH(t.lexeme) > 0
  GROUP BY e.id
),
full_text as (  
  SELECT ts.id,
    row_number() over (
      ORDER BY ts.token_score DESC, ts.type ASC, ts.updated_at DESC
    ) as rank_ix
  FROM token_scores ts
  limit least(match_count, 30) * 2
),
semantic AS (
  SELECT id,
         row_number() OVER (
           ORDER BY embedding <#> query_embedding
         ) AS rank_ix
  FROM base_entities
  WHERE embedding IS NOT NULL
  LIMIT LEAST(match_count, 30) * 2
),
scored AS (
  SELECT COALESCE(ft.id, s.id, ls.id) AS id,
         COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
         COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight +
         COALESCE(1.0 / (rrf_k + ls.rank_ix), 0.0) * literal_weight AS rrf_score
  FROM full_text ft
  FULL JOIN semantic s ON ft.id = s.id
  FULL JOIN literal_search ls ON ls.id = COALESCE(ft.id, s.id)
)
SELECT e.id,
       e.project_id,
       e.type,
       e.content,
       e.created_at,
       e.updated_at,
       e.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight + literal_weight) / (rrf_k + 1)::float) AS similarity,
       COALESCE(1 - (embedding <=> query_embedding) / 2, 0) AS cosine_similarity,
       COALESCE(ts.token_score, 0.0) AS keyword_score,
       COALESCE(ls.literal_count, 0) AS literal_score
FROM scored
JOIN base_entities e ON e.id = scored.id
LEFT JOIN token_scores ts ON ts.id = e.id
LEFT JOIN literal_search ls ON ls.id = e.id
ORDER BY similarity DESC, e.type ASC, e.updated_at DESC
LIMIT match_count;
$$;
`

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
  literal_score as "textScore",
  keyword_score as "keywordScore",
  cosine_similarity as "vecScore",
  similarity as "totalScore"
FROM hybrid_search_entities($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::float, $8::int);
`

const searchDocumentsQuery = `
SELECT
  id,
  project_id AS "projectId",
  type,
  name,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata,
  literal_score as "textScore",
  keyword_score as "keywordScore",
  cosine_similarity as "vecScore",
  similarity as "totalScore"
FROM hybrid_search_documents($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::float, $8::int);
`

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
`

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
  src,
  name,
  content,
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
`

// Clear helpers
const clearDocuments = `TRUNCATE TABLE documents RESTART IDENTITY;`
const clearEntities = `TRUNCATE TABLE entities RESTART IDENTITY;`
const clearDocumentsByProject = `DELETE FROM documents WHERE project_id = ANY($1::text[]);`
const clearEntitiesByProject = `DELETE FROM entities WHERE project_id = ANY($1::text[]);`

export const SQL = {
  schema,
  hybridSearch,

  deleteEntity,
  getEntityById,
  insertEntity,
  updateEntity,
  searchEntitiesQuery,
  matchEntities,
  clearEntities,
  clearEntitiesByProject,

  // Documents
  deleteDocument,
  getDocumentById,
  getDocumentBySrc,
  getChangingDocuments,
  upsertDocument,
  insertDocument,
  updateDocument,
  searchDocumentsQuery,
  matchDocuments,
  clearDocuments,
  clearDocumentsByProject,
}
