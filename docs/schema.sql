
create table "entities" (
    "id" uuid not null default gen_random_uuid(),
    "type" text not null,
    "content" text, 
    "fts" tsvector generated always as (to_tsvector('english', content)) stored,
    "embedding" vector(1536),
    "created_at" timestamp with time zone default now(),
    "updated_at" timestamp with time zone default now()
);
create index on "entities" using gin(fts);
create index on "entities" using hnsw (embedding vector_ip_ops);
alter table "entities" add constraint "entities_pkey" PRIMARY KEY using index "entities_pkey";