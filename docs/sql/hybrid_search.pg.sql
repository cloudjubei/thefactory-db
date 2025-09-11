CREATE OR REPLACE FUNCTION public.hybrid_search_entities(
  query_text        text,
  query_embedding   vector,
  match_count       integer,
  type_filter       text[] DEFAULT NULL,
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
WITH base_entities AS (
  SELECT *
  FROM entities
  WHERE (type_filter IS NULL OR type = ANY(type_filter))
),
full_text AS (
  SELECT
    id,
    row_number() OVER (
      ORDER BY ts_rank_cd(fts, websearch_to_tsquery(query_text)) DESC
    ) AS rank_ix
  FROM base_entities
  WHERE fts @@ websearch_to_tsquery(query_text)
  LIMIT LEAST(match_count, 30) * 2
),
semantic AS (
  SELECT
    id,
    row_number() OVER (
      ORDER BY embedding <=> query_embedding
    ) AS rank_ix
  FROM base_entities
  WHERE embedding IS NOT NULL
  LIMIT LEAST(match_count, 30) * 2
),
scored AS (
  SELECT
    COALESCE(ft.id, s.id) AS id,
    COALESCE(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
    COALESCE(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight AS rrf_score
  FROM full_text ft
  FULL JOIN semantic s ON ft.id = s.id
)
SELECT
  e.id,
  e.type,
  e.content,
  e.created_at,
  e.updated_at,
  e.metadata,
  scored.rrf_score,
  scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) AS similarity,
  (CASE WHEN e.embedding IS NULL THEN NULL ELSE 1 - (e.embedding <=> query_embedding)::float / 2.0 END) AS cosine_similarity,
  ts_rank_cd(e.fts, websearch_to_tsquery(query_text)) AS keyword_score
FROM scored
JOIN base_entities e ON e.id = scored.id
ORDER BY similarity DESC
LIMIT match_count;
$$;
