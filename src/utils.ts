export function readSql(name: string): string | undefined {
  return SQLS[name]
}

export function base64ToUtf8(base64: string) {
  if (base64.startsWith('data:')) {
    const base64Data = base64.split(',')[1]
    return atob(base64Data)
  }
  return atob(base64)
}

// -----------------------------
// CRUD SQL for Entities (jsonb)
// -----------------------------
const delete_entity = `DELETE FROM entities WHERE id = $1;`

const get_entity_by_id = `
SELECT 
  id,
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM entities
WHERE id = $1;
`

const insert_entity = `
INSERT INTO entities (type, content, content_string, embedding, metadata)
VALUES ($1, $2::jsonb, $3, $4::vector, $5::jsonb)
RETURNING *;
`

const update_entity = `
UPDATE entities SET
  type = COALESCE($2, type),
  content = COALESCE($3::jsonb, content),
  content_string = COALESCE($4, content_string),
  embedding = COALESCE($5::vector, embedding),
  metadata = COALESCE($6::jsonb, metadata)
WHERE id = $1;
`

// -------------------------------
// CRUD SQL for Documents (text)
// -------------------------------
const delete_document = `DELETE FROM documents WHERE id = $1;`

const get_document_by_id = `
SELECT 
  id,
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM documents
WHERE id = $1;
`

const insert_document = `
INSERT INTO documents (type, content, src, embedding, metadata)
VALUES ($1, $2, $3, $4::vector, $5::jsonb)
RETURNING *;
`

const update_document = `
UPDATE documents SET
  type = COALESCE($2, type),
  content = COALESCE($3, content),
  src = COALESCE($4, src),
  embedding = COALESCE($5::vector, embedding),
  metadata = COALESCE($6::jsonb, metadata)
WHERE id = $1;
`

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

-- Trigger to keep fts and updated_at in sync for entities
CREATE OR REPLACE FUNCTION entities_before_write()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  NEW.fts = CASE WHEN NEW.content_string IS NULL THEN NULL ELSE to_tsvector('english', NEW.content_string) END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entities_set_fts ON entities;
CREATE TRIGGER entities_set_fts
BEFORE INSERT OR UPDATE OF content ON entities
FOR EACH ROW EXECUTE FUNCTION entities_before_write();

-- Indexes for entities
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
// - Filters with jsonb: { ids: [uuid], types: [text] }
// ----------------------------------------------------------
const hybrid_search = `
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
),
full_text AS (
  SELECT id,
         row_number() OVER (
           ORDER BY ts_rank_cd(fts, websearch_to_tsquery(query_text)) DESC
         ) AS rank_ix
  FROM base_documents
  WHERE fts @@ websearch_to_tsquery(query_text)
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT id,
         row_number() OVER (
           ORDER BY embedding <-> query_embedding
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
       d.type,
       d.content,
       d.src,
       d.created_at,
       d.updated_at,
       d.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) AS similarity,
       CASE WHEN d.embedding IS NULL THEN NULL ELSE 1 - (d.embedding <-> query_embedding)::float END AS cosine_similarity,
       ts_rank_cd(d.fts, websearch_to_tsquery(query_text)) AS keyword_score
FROM scored
JOIN base_documents d ON d.id = scored.id
ORDER BY similarity DESC
LIMIT match_count;
$$;

-- Entitiesb content
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
),
full_text AS (
  SELECT id,
         row_number() OVER (
           ORDER BY ts_rank_cd(fts, websearch_to_tsquery(query_text)) DESC
         ) AS rank_ix
  FROM base_entities
  WHERE fts @@ websearch_to_tsquery(query_text)
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT id,
         row_number() OVER (
           ORDER BY embedding <-> query_embedding
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
       e.type,
       e.content,
       e.created_at,
       e.updated_at,
       e.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) AS similarity,
       CASE WHEN e.embedding IS NULL THEN NULL ELSE 1 - (e.embedding <-> query_embedding)::float END AS cosine_similarity,
       ts_rank_cd(e.fts, websearch_to_tsquery(query_text)) AS keyword_score
FROM scored
JOIN base_entities e ON e.id = scored.id
ORDER BY similarity DESC
LIMIT match_count;
$$;
`

// ----------------------------------------------------------
// Search query wrappers calling hybrid_search_* functions
// ----------------------------------------------------------
const search_entities_query = `
SELECT
  id,
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(metadata) AS metadata,
  keyword_score as text_score,
  cosine_similarity as vec_score,
  similarity as total_score
FROM hybrid_search_entities($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::int)
`

const search_documents_query = `
SELECT
  id,
  type,
  content,
  src,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(metadata) AS metadata,
  keyword_score as text_score,
  cosine_similarity as vec_score,
  similarity as total_score
FROM hybrid_search_documents($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::int)
`

// ----------------------------------------------------------
// Match entities by JSON content containment with filters
//   $1: jsonb pattern to match (content @> $1)
//   $2: jsonb filter { ids?: string[], types?: string[] }
//   $3: int limit (optional)
// ----------------------------------------------------------
const match_entities = `
SELECT
  id,
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM entities
WHERE content @> $1::jsonb
  AND (
    $2::jsonb IS NULL
    OR (
      (NOT ($2 ? 'ids') OR id = ANY (ARRAY(SELECT jsonb_array_elements_text($2->'ids')::uuid)))
      AND (NOT ($2 ? 'types') OR type = ANY (ARRAY(SELECT jsonb_array_elements_text($2->'types'))))
    )
  )
ORDER BY updated_at DESC
LIMIT COALESCE($3::int, 100);
`

const clear_documents = `TRUNCATE TABLE documents RESTART IDENTITY`

const clear_entities = `TRUNCATE TABLE entities RESTART IDENTITY`

const SQLS: Record<string, string> = {
  // Schema and functions
  schema: schema,
  hybrid_search: hybrid_search,

  // Entities
  delete_entity: delete_entity,
  get_entity_by_id: get_entity_by_id,
  insert_entity: insert_entity,
  update_entity: update_entity,
  search_entities_query: search_entities_query,
  match_entities: match_entities,
  clear_entities: clear_entities,

  // Documents
  delete_document: delete_document,
  get_document_by_id: get_document_by_id,
  insert_document: insert_document,
  update_document: update_document,
  search_documents_query: search_documents_query,
  clear_documents: clear_documents,
}
