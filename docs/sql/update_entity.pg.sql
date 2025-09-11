UPDATE entities SET
  type = COALESCE($2, type),
  content = COALESCE($3, content),
  embedding = COALESCE($4, embedding),
  updated_at = $5::timestamptz,
  metadata = COALESCE($6::jsonb, metadata)
WHERE id = $1;
