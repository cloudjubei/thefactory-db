-- Schema for Documents (text) and Entities (json) with hybrid search support
-- Requires: CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS vector;

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector

-- Utility: maintain updated_at
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;$$;

-- Utility: convert jsonb values to space-separated text (exclude keys and punctuation)
CREATE OR REPLACE FUNCTION jsonb_values_to_text(j jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT string_agg(value::text, ' ')
  FROM jsonb_each_text(
    -- flatten json -> keep only leaf text values
    COALESCE(
      (SELECT jsonb_object_agg(k, v)
       FROM (
         SELECT key AS k, value
         FROM jsonb_each(j)
       ) s),
      '{}'::jsonb
    )
  );
$$;

-- A more comprehensive flattener: recursively collect all scalar values
CREATE OR REPLACE FUNCTION jsonb_deep_values(j jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  out_text text := '';
  v jsonb;
  t text;
BEGIN
  IF j IS NULL THEN
    RETURN '';
  END IF;
  IF jsonb_typeof(j) IN ('string','number','boolean') THEN
    RETURN trim(both '"' FROM j::text);
  ELSIF jsonb_typeof(j) = 'array' THEN
    FOR v IN SELECT * FROM jsonb_array_elements(j) LOOP
      t := jsonb_deep_values(v);
      IF t IS NOT NULL AND t <> '' THEN
        out_text := concat_ws(' ', out_text, t);
      END IF;
    END LOOP;
    RETURN out_text;
  ELSIF jsonb_typeof(j) = 'object' THEN
    FOR v IN SELECT value FROM jsonb_each(j) LOOP
      t := jsonb_deep_values(v);
      IF t IS NOT NULL AND t <> '' THEN
        out_text := concat_ws(' ', out_text, t);
      END IF;
    END LOOP;
    RETURN out_text;
  ELSE
    RETURN '';
  END IF;
END;$$;

-- Documents table (text content)
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  content text NOT NULL,
  fts tsvector,
  embedding vector(384),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Entities table (jsonb content)
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  content jsonb NOT NULL,
  fts tsvector,
  embedding vector(384),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Triggers: maintain updated_at
DROP TRIGGER IF EXISTS documents_set_updated_at ON documents;
CREATE TRIGGER documents_set_updated_at
BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS entities_set_updated_at ON entities;
CREATE TRIGGER entities_set_updated_at
BEFORE UPDATE ON entities
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- FTS maintenance: documents from content
CREATE OR REPLACE FUNCTION documents_update_fts()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.fts := to_tsvector('simple', coalesce(NEW.content,''));
  RETURN NEW;
END;$$;

DROP TRIGGER IF EXISTS documents_fts_trigger ON documents;
CREATE TRIGGER documents_fts_trigger
BEFORE INSERT OR UPDATE OF content ON documents
FOR EACH ROW EXECUTE FUNCTION documents_update_fts();

-- FTS maintenance: entities from JSON values only
CREATE OR REPLACE FUNCTION entities_update_fts()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  text_values text;
BEGIN
  text_values := coalesce(jsonb_deep_values(NEW.content), '');
  NEW.fts := to_tsvector('simple', text_values);
  RETURN NEW;
END;$$;

DROP TRIGGER IF EXISTS entities_fts_trigger ON entities;
CREATE TRIGGER entities_fts_trigger
BEFORE INSERT OR UPDATE OF content ON entities
FOR EACH ROW EXECUTE FUNCTION entities_update_fts();

-- Helpful indexes
CREATE INDEX IF NOT EXISTS documents_type_idx ON documents(type);
CREATE INDEX IF NOT EXISTS documents_fts_idx  ON documents USING GIN(fts);
CREATE INDEX IF NOT EXISTS documents_embed_idx ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS entities_type_idx ON entities(type);
CREATE INDEX IF NOT EXISTS entities_fts_idx  ON entities USING GIN(fts);
CREATE INDEX IF NOT EXISTS entities_embed_idx ON entities USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- Hybrid search functions
-- Inputs:
--   query: text query for FTS (websearch syntax)
--   query_vec: embedding of the query
--   text_weight: 0..1 weight for text component (vector component weight = 1 - text_weight)
--   max_results: limit
--   ids: optional filter by id list
--   types: optional filter by type list

CREATE OR REPLACE FUNCTION hybrid_search_documents(
  query text,
  query_vec vector,
  text_weight real DEFAULT 0.6,
  max_results int DEFAULT 25,
  ids uuid[] DEFAULT NULL,
  types text[] DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  type text,
  content text,
  metadata jsonb,
  score real
) LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT d.id, d.type, d.content, d.metadata,
           ts_rank_cd(d.fts, websearch_to_tsquery('simple', query)) AS text_score,
           (1 - (d.embedding <=> query_vec)) AS vector_score
    FROM documents d
    WHERE (ids IS NULL OR d.id = ANY(ids))
      AND (types IS NULL OR d.type = ANY(types))
  )
  SELECT id, type, content, metadata,
         (coalesce(text_weight, 0.6) * coalesce(text_score, 0) + (1 - coalesce(text_weight, 0.6)) * coalesce(vector_score, 0))::real AS score
  FROM base
  WHERE (query IS NULL OR query = '' OR text_score IS NOT NULL)
  ORDER BY score DESC
  LIMIT max_results;
$$;

CREATE OR REPLACE FUNCTION hybrid_search_entities(
  query text,
  query_vec vector,
  text_weight real DEFAULT 0.6,
  max_results int DEFAULT 25,
  ids uuid[] DEFAULT NULL,
  types text[] DEFAULT NULL
) RETURNS TABLE (
  id uuid,
  type text,
  content jsonb,
  metadata jsonb,
  score real
) LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT e.id, e.type, e.content, e.metadata,
           ts_rank_cd(e.fts, websearch_to_tsquery('simple', query)) AS text_score,
           (1 - (e.embedding <=> query_vec)) AS vector_score
    FROM entities e
    WHERE (ids IS NULL OR e.id = ANY(ids))
      AND (types IS NULL OR e.type = ANY(types))
  )
  SELECT id, type, content, metadata,
         (coalesce(text_weight, 0.6) * coalesce(text_score, 0) + (1 - coalesce(text_weight, 0.6)) * coalesce(vector_score, 0))::real AS score
  FROM base
  WHERE (query IS NULL OR query = '' OR text_score IS NOT NULL)
  ORDER BY score DESC
  LIMIT max_results;
$$;

-- JSON containment match for entities
CREATE OR REPLACE FUNCTION match_entities(
  match jsonb,
  max_results int DEFAULT 50,
  ids uuid[] DEFAULT NULL,
  types text[] DEFAULT NULL
) RETURNS SETOF entities LANGUAGE sql STABLE AS $$
  SELECT *
  FROM entities e
  WHERE e.content @> match
    AND (ids IS NULL OR e.id = ANY(ids))
    AND (types IS NULL OR e.type = ANY(types))
  ORDER BY e.updated_at DESC
  LIMIT max_results;
$$;

COMMIT;
