-- Required extensions
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
