
create or replace function hybrid_search_chunks(
  query_text        text,
  query_embedding   vector(512),
  match_count       integer,
  filter jsonb default '{}'::jsonb,
  full_text_weight  float  default 0.5,
  semantic_weight   float  default 0.5,
  rrf_k             integer default 50
)
returns table (
  id uuid,
  tenant_id uuid,
  document_id uuid,
  chunk_index integer,
  content text,
  metadata jsonb,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  rrf_score double precision,
  similarity float,
  cosine_similarity float,
  keyword_score float
)
language sql as
$$
with base_chunks as (
  select *
  from chunks
  where  
    (
      (not filter ? 'ids')
      or id = any (
        array(
          select jsonb_array_elements_text(filter->'ids')::uuid
        )
      )
    )
    and
    (
      (not filter ? 'document_ids')
      or document_id = any (
        array(
          select jsonb_array_elements_text(filter->'document_ids')::uuid
        )
      )
    )
    and
    (
      (not filter ? 'tenant_id')
      or tenant_id = (filter->>'tenant_id')::uuid
    )
),
full_text as (
  select
    id,
    row_number() over (
      order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
    ) as rank_ix
  from base_chunks
  where fts @@ websearch_to_tsquery(query_text)
  limit least(match_count, 30) * 2
),
semantic as (
  select
    id,
    row_number() over (
      order by embedding <#> query_embedding
    ) as rank_ix
  from base_chunks
  where embedding is not null
  limit least(match_count, 30) * 2
),
scored as (
  select
    coalesce(ft.id, s.id) as id,
    coalesce(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight as rrf_score
  from full_text ft
  full join semantic s on ft.id = s.id
)
select
  c.id,
  c.tenant_id,
  c.document_id,
  c.chunk_index,
  c.content,
  c.metadata,
  c.created_at,
  c.updated_at,
  scored.rrf_score,
  scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) as similarity,
  1 - (embedding <=> query_embedding) / 2 as cosine_similarity,
  ts_rank_cd(c.fts, websearch_to_tsquery(query_text)) as keyword_score
from scored
join base_chunks c on c.id = scored.id
order by similarity desc
limit match_count;
$$;

create or replace function hybrid_search_entities(
  query_text        text,
  query_embedding   vector(512),
  match_count       integer,
  filter jsonb default '{}'::jsonb,
  full_text_weight  float  default 0.5,
  semantic_weight   float  default 0.5,
  rrf_k             integer default 50
)
returns table (
  id uuid,
  tenant_id uuid,
  slug text,
  entity_type_id uuid,
  content jsonb,
  owner_id uuid,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  image_url text,
  title text,
  rrf_score double precision,
  similarity float,
  cosine_similarity float,
  keyword_score float
)
language sql as
$$
with base_entities as (
  select *
  from entities
  where  
    (
      (not filter ? 'ids')
      or id = any (
        array(
          select jsonb_array_elements_text(filter->'ids')::uuid
        )
      )
    )
    and
    (
      (not filter ? 'tenant_id')
      or tenant_id = (filter->>'tenant_id')::uuid
    )
    and
    (
      (not filter ? 'entity_type_id')
      or entity_type_id = (filter->>'entity_type_id')::uuid
    )
    and
    (
      (not filter ? 'owner_id')
      or owner_id = (filter->>'owner_id')::uuid
    )
),
full_text as (
  select
    id,
    row_number() over (
      order by ts_rank_cd(fts, websearch_to_tsquery(query_text)) desc
    ) as rank_ix
  from base_entities
  where fts @@ websearch_to_tsquery(query_text)
  limit least(match_count, 30) * 2
),
semantic as (
  select
    id,
    row_number() over (
      order by embedding <#> query_embedding
    ) as rank_ix
  from base_entities
  where embedding is not null
  limit least(match_count, 30) * 2
),
scored as (
  select
    coalesce(ft.id, s.id) as id,
    coalesce(1.0 / (rrf_k + ft.rank_ix), 0.0) * full_text_weight +
    coalesce(1.0 / (rrf_k + s.rank_ix), 0.0) * semantic_weight as rrf_score
  from full_text ft
  full join semantic s on ft.id = s.id
)
select
  e.id,
  e.tenant_id,
  e.slug,
  e.entity_type_id,
  e.content,
  e.owner_id,
  e.created_at,
  e.updated_at,
  e.image_url,
  e.title,
  scored.rrf_score,
  scored.rrf_score / ((full_text_weight + semantic_weight) / (rrf_k + 1)::float) as similarity,
  1 - (embedding <=> query_embedding) / 2 as cosine_similarity,
  ts_rank_cd(e.fts, websearch_to_tsquery(query_text)) as keyword_score
from scored
join base_entities e on e.id = scored.id
order by similarity desc
limit match_count;
$$;


-- grant execute on function hybrid_search_chunks to postgres, anon, authenticated;
-- grant execute on function public.hybrid_search_chunks to postgres, anon, authenticated;
