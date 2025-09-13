SELECT
  id,
  type,
  content,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata,
  keyword_score as text_score,
  cosine_similarity as vec_score,
  similarity as total_score
FROM hybrid_search_entities($1, $2::vector, $3::int, $4::jsonb, $5::float, $6::float, $7::int);