# thefactory-db

Local PostgreSQL DB with hybrid full-text (tsvector) + vector search (pgvector). Embeddings are computed locally using Transformers.js.

## Embeddings

We use @xenova/transformers with the model Xenova/all-MiniLM-L6-v2 to generate sentence embeddings via mean pooling. This runs entirely on-device (Node.js, browsers, Electron, and React Native with a compatible backend).

Notes:
- First run downloads the model weights to a cache. You can control cache directory via environment variables documented in transformers.js.
- Outputs are L2-normalized Float32Array vectors.

## Requirements

- PostgreSQL 15+ (recommended) with the pgvector extension installed
  - CREATE EXTENSION IF NOT EXISTS vector;
  - Optionally: CREATE EXTENSION IF NOT EXISTS pgcrypto; (used by schema defaults)

## Build

```
npm run build
```

## Populate example

Build the package, then run the populate script against your Postgres database (DATABASE_URL or --url):

```
node dist/scripts/populate.js --root . --url postgres://user:pass@localhost:5432/thefactory --textWeight 0.6 --reset
```
