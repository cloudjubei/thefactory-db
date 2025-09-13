-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents table: text content
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  content text,
  fts tsvector GENERATED ALWAYS AS (
    CASE WHEN content IS NULL OR content = '' THEN NULL ELSE to_tsvector('english', content) END
  ) STORED,
  embedding vector(384),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Basic indexes for documents
CREATE INDEX IF NOT EXISTS documents_type_idx ON documents USING btree(type);
CREATE INDEX IF NOT EXISTS documents_fts_idx ON documents USING GIN(fts);
-- Vector index: choose HNSW if available; fallback to IVFFLAT requires ANALYZE and lists setup
-- We'll attempt to create HNSW; if extension/version lacks it, users can adjust manually.
DO $$
BEGIN
  -- Try HNSW
  EXECUTE 'CREATE INDEX IF NOT EXISTS documents_embedding_hnsw_idx ON documents USING hnsw (embedding vector_cosine_ops)';
EXCEPTION WHEN undefined_object THEN
  BEGIN
    -- Fallback to ivfflat
    EXECUTE 'CREATE INDEX IF NOT EXISTS documents_embedding_ivfflat_idx ON documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)';
  EXCEPTION WHEN others THEN
    -- Ignore if vector index cannot be created (table empty or extension mismatch). Users can create later.
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

-- Entities table: jsonb content
CREATE TABLE IF NOT EXISTS entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  content jsonb NOT NULL,
  -- FTS from json values only. Prefer jsonb_to_tsvector if available; fallback implemented below.
  fts tsvector,
  embedding vector(384),
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Compute fts for entities via generated column if jsonb_to_tsvector(values) available, else via trigger
DO $$
BEGIN
  -- Probe for jsonb_to_tsvector signature with 'values'
  PERFORM 1
  FROM pg_proc
  WHERE proname = 'jsonb_to_tsvector'
    AND pg_get_function_arguments(oid) LIKE '%jsonb%values%';

  IF FOUND THEN
    -- If function exists with 'values' option, make fts a generated column
    EXECUTE 'ALTER TABLE entities ALTER COLUMN fts DROP EXPRESSION';
    EXCEPTION WHEN undefined_column THEN NULL;
END$$;

-- We'll implement an always-correct path with a trigger to populate fts from values-only text
-- Helper function to extract only values from jsonb as text
CREATE OR REPLACE FUNCTION jsonb_values_text(j jsonb)
RETURNS text AS $$
DECLARE
  out_text text;
BEGIN
  -- Aggregate all scalar values into a space-separated string
  SELECT string_agg(value, ' ')
  INTO out_text
  FROM (
    SELECT v
    FROM jsonb_paths(j, ARRAY[]::text[])
  ) AS p(path, v)
  JOIN LATERAL (
    SELECT CASE
      WHEN jsonb_typeof(p.v) = 'string' THEN p.v #>> '{}'
      WHEN jsonb_typeof(p.v) IN ('number','boolean') THEN (p.v #>> '{}')
      ELSE NULL
    END AS value
  ) s ON true
  WHERE value IS NOT NULL;

  RETURN COALESCE(out_text, '');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Fallback function for tsvector from values only
CREATE OR REPLACE FUNCTION jsonb_values_tsvector(j jsonb)
RETURNS tsvector AS $$
BEGIN
  BEGIN
    -- Prefer native function if available
    RETURN jsonb_to_tsvector('english', j, 'values');
  EXCEPTION WHEN undefined_function THEN
    RETURN to_tsvector('english', jsonb_values_text(j));
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Trigger to keep fts and updated_at in sync for entities
CREATE OR REPLACE FUNCTION entities_before_write()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  NEW.fts = CASE WHEN NEW.content IS NULL THEN NULL ELSE jsonb_values_tsvector(NEW.content) END;
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
