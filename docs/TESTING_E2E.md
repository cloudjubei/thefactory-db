# End-to-End (E2E) Testing

These tests run against a real PostgreSQL instance with the pgvector extension to validate indexing and hybrid search end-to-end.

## Quick start

1) Start the test database (isolated stack, non-conflicting port):

```bash
docker compose -f docker-compose.e2e.yml up -d db-e2e db-init-e2e
```

- `db-e2e` runs PostgreSQL with pgvector and exposes port 65432 on your host.
- `db-init-e2e` waits for the DB, creates the "thefactory-db" database if missing, and ensures the `vector` extension is enabled. It is safe to re-run.

2) Run the E2E tests

```bash
npm run test:e2e
```

The script uses a hardcoded connection string and sets the required env flags. No additional setup is needed.

Connection used by tests:

```
postgresql://user:password@localhost:65432/thefactory-db
```

Important: E2E tests run sequentially (single process) to avoid database initialization races and deadlocks. The `npm run test:e2e` script enforces this (passes `--threads=false` to Vitest). If you run Vitest manually, ensure you also disable threads for E2E runs.

Run a single E2E file, if desired:

```bash
RUN_E2E=1 DATABASE_URL=postgresql://user:password@localhost:65432/thefactory-db \
  npx vitest run tests/e2e/documents-hybrid.e2e.test.ts --threads=false
```

## What’s covered

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

- Ensure port 65432 is free on your machine.
- Inspect the database:

```bash
docker exec -it thefactory-db-postgres-e2e psql -U user -d "thefactory-db"
```

- First run will download the embedding model for Transformers.js when tests execute hybrid search. This requires internet access or a previously cached model.
