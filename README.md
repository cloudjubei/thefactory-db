# thefactory-db

`thefactory-db` is a standalone, local-first PostgreSQL package with FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across files and documents.

It is designed to be reusable across projects. You can depend on it as a local file dependency ('thefactory-db': 'file:../thefactory-db') or publish it to a private registry.

Database connection is provided via a Postgres connection string.

## What is new

On-demand PostgreSQL with pgvector lifecycle is now built-in:

- Managed ephemeral mode (default): start a temporary Postgres+pgvector container on demand; remove it on destroy.
- External ephemeral mode: create a temporary database on an existing server; drop it on destroy.
- Reusable provisioning (opt-in): create or reuse a local persistent container 'thefactory-db' on port 5435 and initialize schema once.

These flows are built on the image 'pgvector/pgvector:pg16' and the 'testcontainers' library.

## Requirements

- Node.js 18+
- Docker daemon for managed and reusable modes
- Image 'pgvector/pgvector:pg16' (pulled automatically)
- For external mode, the provided user must have CREATEDB privilege and pgvector 'vector' extension must be available/creatable.

## APIs

- openDatabase(options)
- createDatabase(options?)
- destroyDatabase(handle)
- createReusableDatabase(options?)

### Ephemeral managed mode (no connection string)

```ts
import { createDatabase } from 'thefactory-db'

const { client, connectionString, destroy, isManaged, dbName } = await createDatabase({ logLevel: 'warn' })

// Use the client
await client.addDocument({ projectId: 'proj1', type: 'note', src: 'a.txt', name: 'a', content: 'hello' })

// Tear down completely (idempotent)
await destroy()
```

Behavior:
- Starts a fresh container with random credentials and DB name.
- Waits for readiness, then initializes schema and hybrid search functions via openDatabase().
- No reuse, no persistence; destroy() fully stops/removes the container.

### Ephemeral external mode (existing server)

```ts
import { createDatabase, destroyDatabase } from 'thefactory-db'

const serverUrl = 'postgresql://user:password@localhost:55432/thefactory-db'
const handle = await createDatabase({ connectionString: serverUrl, logLevel: 'warn' })

await handle.client.addDocument({ projectId: 'proj2', type: 'note', src: 'b.txt', name: 'b', content: 'hello ext' })

// Drop the temporary database
await destroyDatabase(handle.handle)
```

Behavior:
- Generates a temporary database name like 'tfdb_<random>'.
- Connects to admin DB 'postgres' to CREATE DATABASE, then opens/initializes the new DB.
- On destroy, drops the temporary database after terminating its connections.

Notes:
- The provided user must be able to CREATE DATABASE.
- The server must have the 'vector' extension installed (or creatable). If missing, initialization will fail with a clear error.

### Reusable persistent provisioning (opt-in)

```ts
import { createReusableDatabase, openDatabase } from 'thefactory-db'

const { connectionString, created } = await createReusableDatabase({ logLevel: 'warn' })
// Connect and use
const db = await openDatabase({ connectionString, logLevel: 'warn' })
await db.close()
```

Behavior:
- Manages a Docker container named 'thefactory-db' with:
  - POSTGRES_USER='thefactory', POSTGRES_PASSWORD='thefactory', POSTGRES_DB='thefactorydb'
  - Host port 5435 mapped to container 5432
- Idempotent: if the container exists and is running, returns the same URL; if stopped, starts it; if missing, creates it.
- Initializes schema on first creation via openDatabase(), then closes the pool.
- Does not destroy or drop data.

Returned URL example:
- 'postgresql://thefactory:thefactory@127.0.0.1:5435/thefactorydb'

## Development

For an overview of the project structure and coding standards, please refer to the following documents:

- [File and Tooling Organisation](docs/FILE_ORGANISATION.md)
- [Code Standard and Architecture Guide](docs/CODE_STANDARD.md)

## Testing

- Unit tests live under 'tests/' and mock external dependencies for speed and determinism.
- End-to-End tests live under 'tests/e2e/' and run against a real PostgreSQL database with 'pgvector'. For running e2e tests check out [the docs](docs/TESTING_E2E.md)

To run lifecycle smoke tests:

- Managed ephemeral (requires Docker):

```bash
RUN_E2E=1 vitest run tests/e2e/lifecycle.e2e.test.ts -t 'Managed'
```

- External ephemeral (requires existing server and CREATEDB):

```bash
RUN_E2E=1 DATABASE_URL=postgresql://user:password@localhost:65432/thefactory-db \
  vitest run tests/e2e/lifecycle.e2e.test.ts -t 'External'
```

- Reusable provisioning (requires Docker):

```bash
RUN_E2E=1 vitest run tests/e2e/lifecycle.e2e.test.ts -t 'Reusable'
```

## Setup

You can still use a pre-existing Postgres with pgvector and connect directly via openDatabase().

### Option 1: Local PostgreSQL Installation (from scratch)

1. Install PostgreSQL

- macOS: 'brew install postgresql@16' (or use the official installer)
- Windows: Download and run the installer from postgresql.org
- Linux (Debian/Ubuntu): 'sudo apt-get install -y postgresql postgresql-contrib'

2. Start PostgreSQL

- macOS/Linux (service): 'sudo service postgresql start' (or use your OS service manager)
- Windows: The installer starts the service automatically

3. Create the database and user

- Open the PostgreSQL shell as an admin user (often 'postgres'):
  - Linux/macOS: 'sudo -u postgres psql'
  - Windows: Run 'psql' from the Start Menu (as the superuser you set during install)
- Run the following SQL (note the hyphen in the DB name requires double quotes):

```sql
CREATE USER "user" WITH ENCRYPTED PASSWORD 'password';
CREATE DATABASE "thefactory-db" OWNER "user";
GRANT ALL PRIVILEGES ON DATABASE "thefactory-db" TO "user";
```

4. Install and enable the pgvector extension

- Install pgvector following: https://github.com/pgvector/pgvector
- Connect to your new database and enable the extension:

```bash
psql -U user -d "thefactory-db" -h 127.0.0.1 -p 5432 -W
```

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

5. Connection URL

- Your connection string will be:

```
postgresql://user:password@localhost:5432/thefactory-db
```

Tip: Because the database name contains a hyphen, you must always quote it in SQL statements as "thefactory-db". The connection URL does not require quotes.

---

### Option 2: Docker (recommended for convenience)

This repo includes a ready-to-use Docker Compose setup with 'pgvector' and a bootstrap job that ensures the target database exists even if a persistent volume already exists.

1. Start the database and the bootstrap job

```bash
docker compose up -d db db-init
```

- 'db' runs the PostgreSQL server with 'pgvector' and exposes it on host port 55432 to avoid clashing with any local Postgres on 5432.
- 'db-init' waits for the DB, creates the database if missing, and enables the 'vector' extension. You can safely re-run it:

```bash
docker compose run --rm db-init
```

2. Connection URL

```
postgresql://user:password@localhost:55432/thefactory-db
```

3. Troubleshooting / resetting

- Ensure you are connecting to the Dockerized Postgres (port 55432), not a locally installed Postgres on 5432. Mismatched connections can make it appear like updates are 'in-memory' only when you are actually reading from a different server on subsequent runs.
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

## Usage (direct connection)

```typescript
import { openDatabase } from 'thefactory-db'

// Set DATABASE_URL in your environment or provide it directly
const db = await openDatabase({ connectionString: process.env.DATABASE_URL! })

// Add a text document
const doc = await db.addDocument({
  projectId: 'my-project',
  type: 'project_file',
  src: 'README.md',
  name: 'README',
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

The 'openDatabase' function will:

1. Connect to your PostgreSQL database
2. Initialize the required schema and functions (executed from embedded SQL)
3. Ensure the 'vector' and 'pgcrypto' extensions are enabled (idempotent)

The returned 'db' object provides an API for adding/searching documents and entities, as well as a 'raw()' method for direct 'pg.Client' access.

## Utilities

Two simple scripts are included for convenience (run after 'npm run build' so 'dist/' is present):

- Clear all (or by project):

```bash
node scripts/clear.ts -- --url postgresql://user:password@localhost:55432/thefactory-db --p my-project
```

- Count selected documents:

```bash
node scripts/count.ts -- --url postgresql://user:password@localhost:55432/thefactory-db
```
