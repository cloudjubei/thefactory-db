# E2E Tests with a Real Postgres DB

These end-to-end tests exercise the full stack against a real PostgreSQL database with the pgvector extension. They are opt-in to avoid heavy CI costs.

## Quick Start (Docker Compose)

This repository includes a ready-to-use Postgres + pgvector setup.

1) Start the database and the bootstrap job

```
docker compose up -d db db-init
```

- `db` runs PostgreSQL 16 with the pgvector extension available.
- `db-init` waits for the DB, creates database `thefactory-db` if missing, and ensures the `vector` extension is enabled. You can safely re-run it:

```
docker compose run --rm db-init
```

2) Export a connection URL for the tests

```
export DATABASE_URL="postgresql://user:password@localhost:5432/thefactory-db"
```

3) Run only the E2E tests

E2E tests are opt-in and will be skipped unless you explicitly enable them:

```
# build first if needed
npm run build

# run E2E only
RUN_E2E=1 npx vitest run tests/e2e
```

You can also run the whole suite (unit + E2E), though it may take longer. E2E tests still require `RUN_E2E=1`.

```
RUN_E2E=1 npm test
```

4) Reset database (optional)

If you want to reset all data:

```
docker compose down -v
# then recreate
docker compose up -d db db-init
```

5) Inspect the DB

```
docker exec -it thefactory-db-postgres psql -U user -d "thefactory-db"
```

## Notes on Embeddings

These tests use the local embedding provider (Transformers.js) by default, which may download the ONNX model on first use. To speed this up across runs, set a cache location:

- Linux/macOS: export TRANSFORMERS_CACHE="$HOME/.cache/transformers"
- Windows (PowerShell): $env:TRANSFORMERS_CACHE = "$HOME/.cache/transformers"

If you prefer to avoid running embeddings-heavy tests, keep E2E disabled (do not set RUN_E2E=1). The unit tests already mock embeddings and cover behavior thoroughly.
