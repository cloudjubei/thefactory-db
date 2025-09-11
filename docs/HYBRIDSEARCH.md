# Hybrid Search Implementation Notes

This package implements hybrid search (full‑text + embedding) in PostgreSQL using a dedicated SQL function named `public.hybrid_search_entities`.

Highlights:
- Full‑text search uses a generated `tsvector` column (`fts`) over `content` with a GIN index.
- Embedding similarity uses the `pgvector` extension with cosine distance via `vector_cosine_ops` index.
- Results are merged using Reciprocal Rank Fusion (RRF), with separate weights for the text and semantic modalities.
- The function accepts an optional `type_filter` (`text[]`) to restrict by entity type.

Function signature:
- hybrid_search_entities(
  query_text text,
  query_embedding vector,
  match_count integer,
  type_filter text[] DEFAULT NULL,
  full_text_weight float DEFAULT 0.5,
  semantic_weight float DEFAULT 0.5,
  rrf_k integer DEFAULT 50
)

Returned columns include: id, type, content, created_at/updated_at, metadata, rrf_score, normalized similarity, cosine_similarity, and keyword_score.

Important notes and constraints:
- Embedding dimension is set to 384 to match the local Transformers.js model (Xenova/all-MiniLM-L6-v2). Ensure your model outputs 384‑dim vectors or adjust `schema.pg.sql` accordingly.
- The column index is created with `vector_cosine_ops`; the hybrid function uses the cosine distance operator `<=>`.
- We cast the bound embedding parameter to `vector` in queries calling the function; PostgreSQL will parse the `[...]` literal supplied by the app into a vector value.
- If an existing database has a different embedding dimension (e.g., 1536), a migration is required to change the column type; this package does not perform automatic migrations.
