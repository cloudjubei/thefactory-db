# End-to-End (E2E) Testing

These tests run against a real PostgreSQL instance with the pgvector extension to validate embeddings, tokenization, indexing, and hybrid search end-to-end.

## Quick start

1) Start the test database (isolated stack, non-conflicting port):

```bash
docker compose -f docker-compose.e2e.yml up -d db-e2e db-init-e2e
```

- `db-e2e` runs PostgreSQL with pgvector and exposes port 55432 on your host.
- `db-init-e2e` waits for the DB, creates the "thefactory-db" database if missing, and ensures the `vector` extension is enabled. It is safe to re-run.

2) Run the E2E tests

```bash
npm run test:e2e
```

The script uses a hardcoded connection string and sets the required env flags. No additional setup is needed.

Connection used by tests:

```
postgresql://user:password@localhost:55432/thefactory-db
```

## What’s covered

- Tokenizer utilities (runtime correctness)
- Embeddings provider via Transformers.js (model loads, returns unit-norm vectors)
- Documents: indexing CRUD + hybrid search
- Entities: indexing CRUD + hybrid search

Tests live under `tests/e2e/`.

## Re-running or resetting

- Re-run init only:

```bash
docker compose -f docker-compose.e2e.yml run --rm db-init-e2e
```

- Tear down everything and remove volumes (reset all data):

```bash
docker compose -f docker-compose.e2e.yml down -v
# then start again
docker compose -f docker-compose.e2e.yml up -d db-e2e db-init-e2e
```

## Troubleshooting

- Ensure port 55432 is free on your machine.
- Inspect the database:

```bash
docker exec -it thefactory-db-postgres-e2e psql -U user -d "thefactory-db"
```

- First run will download a small embedding model for Transformers.js. This requires internet access or a previously cached model.
