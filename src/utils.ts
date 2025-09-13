// import delete_entity_pg from '../docs/sql/delete_entity.pg.sql';
// import get_entity_by_id_pg from '../docs/sql/get_entity_by_id.pg.sql';
// import insert_entity_pg from '../docs/sql/insert_entity.pg.sql';
// import schema_pg from '../docs/sql/schema.pg.sql';
// import search_entities_pg from '../docs/sql/search_entities.pg.sql';
// import update_entity_pg from '../docs/sql/update_entity.pg.sql';
// import hybrid_search_pg from '../docs/sql/hybrid_search.pg.sql';

export function readSql(name: string): string | undefined {
  return SQLS[name]
  // const b64 = SQLS[name];
  // if (b64 !== undefined) {
  //   return base64ToUtf8(b64);
  // }
}

export function base64ToUtf8(base64: string) {
  if (base64.startsWith('data:')) {
    const base64Data = base64.split(',')[1]
    return atob(base64Data)
  }
  return atob(base64)
}

const delete_entity_pg = `DELETE FROM entities WHERE id = $1`
const get_entity_by_id_pg = `
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
const insert_entity_pg = `INSERT INTO entities (id, type, content, embedding, created_at, updated_at, metadata)
VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb);`
const schema_pg = `-- Required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('project_file','internal_document','external_blob')),
  content text,
  fts tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content,''))) STORED,
  embedding vector(384),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);

CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entities_fts ON entities USING gin(fts);
-- Use cosine ops as embeddings are L2-normalized
DO $$ BEGIN
  CREATE INDEX idx_entities_embedding ON entities USING hnsw (embedding vector_cosine_ops);
EXCEPTION WHEN others THEN
  -- Fallback to ivfflat if hnsw not available
  BEGIN
    CREATE INDEX IF NOT EXISTS idx_entities_embedding_ivf ON entities USING ivfflat (embedding vector_cosine_ops);
  EXCEPTION WHEN others THEN
    -- ignore
  END;
END $$;
`

const search_entities_pg = `
WITH params AS (
  SELECT 
    websearch_to_tsquery($1) AS tsq,
    $2::float AS tw,
    $3::int AS lim
)
SELECT 
  e.id,
  e.type,
  e.content,
  null::text as tokenized_content,
  null::text as embedding,
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(e.metadata) AS metadata,
  ts_rank_cd(e.fts, (SELECT tsq FROM params)) AS text_score,
  (1 - (e.embedding <=> $4)::float / 2.0) AS vec_score,
  (SELECT tw FROM params) * COALESCE(ts_rank_cd(e.fts, (SELECT tsq FROM params)), 0.0) + 
  (1.0 - (SELECT tw FROM params)) * COALESCE((1 - (e.embedding <=> $4)::float / 2.0), 0.0) AS total_score
FROM entities e
WHERE 1=1
/*TYPE_FILTER*/
ORDER BY total_score DESC
LIMIT (SELECT lim FROM params);
`
const update_entity_pg = `
UPDATE entities SET
  type = COALESCE($2, type),
  content = COALESCE($3, content),
  embedding = COALESCE($4, embedding),
  updated_at = $5::timestamptz,
  metadata = COALESCE($6::jsonb, metadata)
WHERE id = $1;
`

// Document SQL
const delete_document_pg = `DELETE FROM documents WHERE id = $1;`
const get_document_by_id_pg = `
SELECT 
  id,
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM documents
WHERE id = $1;
`
const insert_document_pg = `INSERT INTO documents (id, type, content, embedding, created_at, updated_at, metadata)
VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb);`
const update_document_pg = `
UPDATE documents SET
  type = COALESCE($2, type),
  content = COALESCE($3, content),
  embedding = COALESCE($4, embedding),
  updated_at = $5::timestamptz,
  metadata = COALESCE($6::jsonb, metadata)
WHERE id = $1;
`

// New hybrid search functions for documents and entities with ids/types filter via jsonb
const hybrid_search_pg = `
-- Documents: text content
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
           ORDER BY embedding <#> query_embedding
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
       d.created_at,
       d.updated_at,
       d.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) AS similarity,
       CASE WHEN d.embedding IS NULL THEN NULL ELSE 1 - (d.embedding <=> query_embedding)::float / 2.0 END AS cosine_similarity,
       ts_rank_cd(d.fts, websearch_to_tsquery(query_text)) AS keyword_score
FROM scored
JOIN base_documents d ON d.id = scored.id
ORDER BY similarity DESC
LIMIT match_count;
$$;

-- Entities: jsonb content
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
           ORDER BY embedding <#> query_embedding
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
       CASE WHEN e.embedding IS NULL THEN NULL ELSE 1 - (e.embedding <=> query_embedding)::float / 2.0 END AS cosine_similarity,
       ts_rank_cd(e.fts, websearch_to_tsquery(query_text)) AS keyword_score
FROM scored
JOIN base_entities e ON e.id = scored.id
ORDER BY similarity DESC
LIMIT match_count;
$$;
`

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
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS "updatedAt",
  to_jsonb(metadata) AS metadata,
  keyword_score as text_score,
  cosine_similarity as vec_score,
  similarity as total_score
FROM hybrid_search_documents($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::int)
`

const SQLS: Record<string, string> = {
  // Entities
  delete_entity: delete_entity_pg,
  get_entity_by_id: get_entity_by_id_pg,
  insert_entity: insert_entity_pg,
  schema: schema_pg,
  search_entities: search_entities_pg,
  update_entity: update_entity_pg,
  hybrid_search: hybrid_search_pg,
  search_entities_query: search_entities_query,
  // Documents
  delete_document: delete_document_pg,
  get_document_by_id: get_document_by_id_pg,
  insert_document: insert_document_pg,
  update_document: update_document_pg,
  search_documents_query: search_documents_query,
}
