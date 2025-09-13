-- Reference hybrid search queries and examples for both tables

-- Documents hybrid search
-- Example usage:
-- SELECT * FROM hybrid_search_documents(
--   query => 'vector indices',
--   query_vec => '[0.01, 0.02, ...]'::vector,
--   text_weight => 0.6,
--   max_results => 20,
--   ids => ARRAY['7f1b2e86-0c0e-4c30-b8e2-bb6d6e7bd2e8']::uuid[],
--   types => ARRAY['readme','code']
-- );

-- Entities hybrid search
-- Example usage:
-- SELECT * FROM hybrid_search_entities(
--   query => 'http handler',
--   query_vec => '[0.1, 0.3, ...]'::vector,
--   text_weight => 0.5,
--   max_results => 50,
--   ids => NULL,
--   types => ARRAY['route','component']
-- );

-- Entities JSON match
-- Find entities where content contains the given shape:
-- SELECT * FROM match_entities(
--   match => '{"info": {"category": "text"}}'::jsonb,
--   max_results => 100,
--   ids => NULL,
--   types => ARRAY['note']
-- );

-- Notes:
-- - ids and types filters are optional; pass NULL to ignore.
-- - text_weight balances FTS score vs vector similarity: final_score = text_weight * ts_rank + (1-text_weight) * (1 - cosine_distance)
-- - Ensure ivfflat indexes are built after populating some data and with appropriate lists parameter.
