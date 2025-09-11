SELECT 
  e.id, e.type, e.content, e.tokenized_content, e.embedding, e.createdAt, e.updatedAt, e.metadata,
  fs.text_score AS text_score,
  cosine_sim(e.embedding, @qvec) AS vec_score,
  (@tw) * COALESCE(fs.text_score, 0.0) + (1.0 - @tw) * COALESCE(cosine_sim(e.embedding, @qvec), 0.0) AS total_score
FROM entities e
LEFT JOIN (
  SELECT id, 1.0 / (1.0 + bm25(entities_fts)) AS text_score
  FROM entities_fts
  WHERE entities_fts MATCH @match
) fs ON fs.id = e.id
WHERE 1=1
/*TYPE_FILTER*/
ORDER BY total_score DESC
LIMIT @limit;
