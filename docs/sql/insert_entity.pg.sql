INSERT INTO entities (id, type, content, embedding, created_at, updated_at, metadata)
VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7::jsonb);
