UPDATE entities SET
  type = coalesce(@type, type),
  content = coalesce(@content, content),
  tokenized_content = coalesce(@tokenized_content, tokenized_content),
  embedding = coalesce(@embedding, embedding),
  updatedAt = @updatedAt,
  metadata = coalesce(@metadata, metadata)
WHERE id = @id;
