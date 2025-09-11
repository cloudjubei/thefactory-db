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
  to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(e.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
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
