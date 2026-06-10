import type { Migration } from './types.js'

/**
 * Adds the `external_key` dedup column + `(project_id, type, external_key)`
 * unique index (the ON CONFLICT arbiter for `upsertEntity`), and recreates
 * `hybrid_search_entities` so its `RETURNS TABLE` projects `should_embed` and
 * `external_key` — `searchEntitiesQuery` selects both. The function is
 * dropped first because a `RETURNS TABLE` change cannot go through
 * `CREATE OR REPLACE`.
 */
export const migration003: Migration = {
  version: 3,
  id: '003-entities-external-key',
  up: async ({ client }) => {
    await client.query(`
      ALTER TABLE entities
        ADD COLUMN IF NOT EXISTS external_key text;
      CREATE UNIQUE INDEX IF NOT EXISTS entities_project_type_external_key_uniq
        ON entities (project_id, type, external_key);
    `)
    await client.query(ENTITIES_SEARCH_FUNCTION)
  },
}

export const ENTITIES_SEARCH_FUNCTION = `
DROP FUNCTION IF EXISTS hybrid_search_entities(text, vector, integer, jsonb, float, float, float, integer);

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
  should_embed boolean,
  external_key text,
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
sanitized_query AS (
  SELECT regexp_replace(trim(coalesce(query_text, '')), '[^[:alnum:] ]+', '', 'g') AS cleaned_text
),
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
token_scores AS (
  SELECT e.id, e.type, e.updated_at,
         ts_rank_cd(e.fts, t.ts_query) AS token_score
  FROM base_entities e
  CROSS JOIN or_ts_query t
  WHERE e.fts @@ t.ts_query
),
literal_search AS (
  SELECT e.id,
         COALESCE(SUM((LENGTH(e.content::text) - LENGTH(REPLACE(e.content::text, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) +
         COALESCE(SUM((LENGTH(e.type) - LENGTH(REPLACE(e.type, t.lexeme, ''))) / LENGTH(t.lexeme)), 0) AS literal_count,
         dense_rank() OVER (ORDER BY (
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
       e.should_embed,
       e.external_key,
       e.created_at,
       e.updated_at,
       e.metadata,
       scored.rrf_score,
       scored.rrf_score / ((full_text_weight + semantic_weight + literal_weight) / (rrf_k + 1)::float) AS similarity,
       CASE WHEN e.embedding IS NULL OR query_embedding IS NULL THEN 0
            ELSE (1 - (e.embedding <=> query_embedding) / 2)
       END AS cosine_similarity,
       COALESCE(ts.token_score, 0.0) AS keyword_score,
       COALESCE(ls.literal_count, 0) AS literal_score
FROM scored
JOIN base_entities e ON e.id = scored.id
LEFT JOIN token_scores ts ON ts.id = e.id
LEFT JOIN literal_search ls ON ls.id = e.id
ORDER BY similarity DESC, cosine_similarity DESC, keyword_score DESC, literal_score DESC, e.type ASC, e.updated_at DESC
LIMIT match_count;
$$;
`
