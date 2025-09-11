SELECT 
  id,
  type,
  content,
  null::text as tokenized_content,
  null::text as embedding,
  to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "createdAt",
  to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "updatedAt",
  to_jsonb(metadata) AS metadata
FROM entities
WHERE id = $1;
