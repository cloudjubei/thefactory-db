# thefactory-db

`thefactory-db` is a standalone, local-first PostgreSQL package with FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across files and documents.

It is designed to be reusable across projects. You can depend on it as a local file dependency ("thefactory-db": "file:../thefactory-db") or publish it to a private registry.

Database connection is provided via a Postgres connection string.

## Development

For an overview of the project structure and coding standards, please refer to the following documents:

- File and Tooling Organisation (docs/FILE_ORGANISATION.md)
- Code Standard and Architecture Guide (docs/CODE_STANDARD.md)

## Testing

We are committed to maintaining a high standard of code quality and reliability. Comprehensive testing is vital to the project. We aim for near 100% coverage with meaningful tests that exercise core logic, edge cases, and error handling.

Important: Do not modify code just to make tests pass. The implementation must remain sensible and correct; tests should reveal issues, not enforce hacks. All inputs to the public API are validated at runtime (see `src/validation.ts`), and tests assert that malformed inputs are rejected.

For detailed guidance on our testing philosophy, tools, validation expectations, and best practices, please refer to our Testing Guidelines (docs/TESTING.md).

## Setup

To use `thefactory-db`, you need a running PostgreSQL instance with the `pgvector` extension enabled. You have two options:

### Option 1: Local PostgreSQL Installation (from scratch)

1) Install PostgreSQL
- macOS: `brew install postgresql@16` (or use the official installer)
- Windows: Download and run the installer from postgresql.org
- Linux (Debian/Ubuntu): `sudo apt-get install -y postgresql postgresql-contrib`

2) Start PostgreSQL
- macOS/Linux (service): `sudo service postgresql start` (or use your OS service manager)
- Windows: The installer starts the service automatically

3) Create the database and user
- Open the PostgreSQL shell as an admin user (often `postgres`):
  - Linux/macOS: `sudo -u postgres psql`
  - Windows: Run `psql` from the Start Menu (as the superuser you set during install)
- Run the following SQL (note the hyphen in the DB name requires double quotes):

```sql
CREATE USER "user" WITH ENCRYPTED PASSWORD 'password';
CREATE DATABASE "thefactory-db" OWNER "user";
GRANT ALL PRIVILEGES ON DATABASE "thefactory-db" TO "user";
```

4) Install and enable the pgvector extension
- Install pgvector following: https://github.com/pgvector/pgvector
- Connect to your new database and enable the extension:

```bash
psql -U user -d "thefactory-db" -h 127.0.0.1 -p 5432 -W
```

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

5) Connection URL
- Your connection string will be:

```
postgresql://user:password@localhost:5432/thefactory-db
```

Tip: Because the database name contains a hyphen, you must always quote it in SQL statements as "thefactory-db". The connection URL does not require quotes.

---

### Option 2: Docker (recommended for convenience)

This repo includes a ready-to-use Docker Compose setup with `pgvector` and a bootstrap job that ensures the target database exists even if a persistent volume already exists.

1) Start the database and the bootstrap job

```bash
docker compose up -d db db-init
```

- `db` runs the PostgreSQL server with `pgvector`.
- `db-init` waits for the DB, creates the database if missing, and enables the `vector` extension. You can safely re-run it:

```bash
docker compose run --rm db-init
```

2) Connection URL

```
postgresql://user:password@localhost:5432/thefactory-db
```

3) Troubleshooting / resetting
- If you previously started Postgres with a volume that did not have the database, `db-init` will create it for you.
- To completely reset the database (including deleting all data):

```bash
docker compose down -v
# then re-create
docker compose up -d db db-init
```

- To inspect the database shell:

```bash
docker exec -it thefactory-db-postgres psql -U user -d "thefactory-db"
```

## Usage

```typescript
import { openDatabase } from 'thefactory-db'

// Set DATABASE_URL in your environment or provide it directly
const db = await openDatabase({ connectionString: process.env.DATABASE_URL! })

// Add a text document
const doc = await db.addDocument({
  projectId: 'my-project',
  type: 'project_file',
  src: 'README.md',
  content: 'This is a test document about hybrid search.',
  metadata: { author: 'dev' },
})

// Perform a hybrid search over documents
const results = await db.searchDocuments({
  query: 'hybrid search test',
  textWeight: 0.6,
  limit: 5,
})

console.log(results)
```

The `openDatabase` function will:
1) Connect to your PostgreSQL database
2) Initialize the required schema and functions (executed from embedded SQL)
3) Ensure the `vector` and `pgcrypto` extensions are enabled (idempotent)

The returned `db` object provides an API for adding/searching documents and entities, as well as a `raw()` method for direct `pg.Client` access.

## Utilities

Two simple scripts are included for convenience (run after `npm run build` so `dist/` is present):

- Clear all (or by project):

```bash
node scripts/clear.ts -- --url postgresql://user:password@localhost:5432/thefactory-db --p my-project
```

- Count selected documents:

```bash
node scripts/count.ts -- --url postgresql://user:password@localhost:5432/thefactory-db
```
