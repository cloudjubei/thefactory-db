# thefactory-db

`thefactory-db` is a standalone, local-first PostgreSQL package with FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across files and documents.

It is designed to be reusable across projects. You can depend on it as a local file dependency ("thefactory-db": "file:../thefactory-db") or publish it to a private registry.

Database connection is provided via a Postgres connection string.

## Development

For an overview of the project structure and coding standards, please refer to the following documents:

- [File and Tooling Organisation](docs/FILE_ORGANISATION.md)
- [Code Standard and Architecture Guide](docs/CODE_STANDARD.md)

## Testing

We are committed to maintaining a high standard of code quality and reliability. Comprehensive testing is vital to the project. We aim for near 100% coverage with meaningful tests that exercise core logic, edge cases, and error handling.

Important: Do not modify code just to make tests pass. The implementation must remain sensible and correct; tests should reveal issues, not enforce hacks. All inputs to the public API are validated at runtime (see `src/validation.ts`), and tests assert that malformed inputs are rejected.

- Unit tests live under `tests/` and mock external dependencies for speed and determinism.
- End-to-End tests live under `tests/e2e/` and run against a real PostgreSQL database with `pgvector`. For running e2e tests check out [the docs](docs/TESTING_E2E.md)

For detailed guidance on our testing philosophy, tools, validation expectations, and best practices, please refer to our [Testing Guidelines](docs/TESTING.md).

## Setup

To use `thefactory-db`, you need a running PostgreSQL instance with the `pgvector` extension enabled. You have two options:

### Option 1: Local PostgreSQL Installation (from scratch)

1. Install PostgreSQL

- macOS: `brew install postgresql@16` (or use the official installer)
- Windows: Download and run the installer from postgresql.org
- Linux (Debian/Ubuntu): `sudo apt-get install -y postgresql postgresql-contrib`

2. Start PostgreSQL

- macOS/Linux (service): `sudo service postgresql start` (or use your OS service manager)
- Windows: The installer starts the service automatically

3. Create the database and user

- Open the PostgreSQL shell as an admin user (often `postgres`):
  - Linux/macOS: `sudo -u postgres psql`
  - Windows: Run `psql` from the Start Menu (as the superuser you set during install)
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

This repo includes a ready-to-use Docker Compose setup with `pgvector` and a bootstrap job that ensures the target database exists even if a persistent volume already exists.

1. Start the database and the bootstrap job

```bash
docker compose up -d db db-init
```

- `db` runs the PostgreSQL server with `pgvector` and exposes it on host port 55432 to avoid clashing with any local Postgres on 5432.
- `db-init` waits for the DB, creates the database if missing, and enables the `vector` extension. You can safely re-run it:

```bash
docker compose run --rm db-init
```

2. Connection URL

```
postgresql://user:password@localhost:55432/thefactory-db
```

3. Troubleshooting / resetting

- Ensure you are connecting to the Dockerized Postgres (port 55432), not a locally installed Postgres on 5432. Mismatched connections can make it appear like updates are "in-memory" only when you are actually reading from a different server on subsequent runs.
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

1. Connect to your PostgreSQL database
2. Initialize the required schema and functions (executed from embedded SQL)
3. Ensure the `vector` and `pgcrypto` extensions are enabled (idempotent)

The returned `db` object provides an API for adding/searching documents and entities, as well as a `raw()` method for direct `pg.Client` access.

## Utilities

Two simple scripts are included for convenience (run after `npm run build` so `dist/` is present):

- Clear all (or by project):

```bash
node scripts/clear.ts -- --url postgresql://user:password@localhost:55432/thefactory-db --p my-project
```

- Count selected documents:

```bash
node scripts/count.ts -- --url postgresql://user:password@localhost:55432/thefactory-db
```

## On-demand database lifecycle

thefactory-db can provision and manage PostgreSQL with pgvector for you, or connect to an existing server. Three flows are supported:

1) Ephemeral managed (default)
2) Ephemeral external (uses your server; creates a temporary database)
3) Reusable managed persistent (local Docker container you can reuse across runs)

These flows are intentionally simple: no reuse for ephemeral flows and full teardown on destroy; the reusable flow is persistent and never drops data.

### 1) Ephemeral managed (default)

Starts a fresh Postgres+pgvector container using `pgvector/pgvector:pg16` via Testcontainers, initializes schema, and returns a ready client. On destroy, the container is stopped and removed. No reuse, no persistence.

Requirements:
- Docker daemon available and accessible to the current user
- Image `pgvector/pgvector:pg16` (pulled automatically if missing)

Example:

```ts
import { createDatabase } from 'thefactory-db'

const { client, connectionString, destroy, isManaged, dbName } = await createDatabase()
console.log('Ephemeral DB ready', { connectionString, isManaged, dbName })

try {
  await client.addDocument({
    projectId: 'demo',
    type: 'md',
    src: 'README.md',
    name: 'Readme',
    content: 'Hello world',
  })
  const results = await client.searchDocuments({ query: 'hello', limit: 5 })
  console.log(results)
} finally {
  await destroy() // fully tears down the container
}
```

Notes:
- Health/readiness is ensured by waiting for the listening port and validating with `SELECT 1`.
- Schema bootstrap (tables, triggers, extensions) is performed via `openDatabase()` automatically.
- Managed containers started by this process are also cleaned up on SIGINT/SIGTERM.

### 2) Ephemeral external (server-managed with temporary database)

Connect to an existing PostgreSQL server by supplying a server-level connection string. A temporary database named `tfdb_<random>` is created, initialized, and used for the session. On destroy, the temporary database is dropped.

Requirements:
- The provided role must have `CREATEDB` privilege on the server
- The `pgvector` extension must be available/creatable as `vector`

Example:

```ts
import { createDatabase } from 'thefactory-db'

// Supply a server-level connection string (database portion is ignored for admin ops)
const serverUrl = 'postgresql://user:password@localhost:5432/postgres'
const handle = await createDatabase({ connectionString: serverUrl })

console.log('Temp DB created:', handle.dbName, 'URL:', handle.connectionString)
try {
  // use handle.client as usual
  const rows = await handle.client.searchEntities({ query: 'test', limit: 5 })
  console.log(rows)
} finally {
  await handle.destroy() // drops the temporary database
}
```

Notes:
- Admin operations run against the `postgres` database on the same server to create/drop the temp DB.
- Initialization will fail with a clear error if `vector` is not available or cannot be created.
- No schema-only cleanup: the entire temporary database is dropped.

### 3) Reusable managed persistent (local Docker)

Create or reuse a long-lived local Docker container named `thefactory-db` using `pgvector/pgvector:pg16`. Intended for development workflows where you want a stable, persistent database across runs.

Requirements:
- Docker daemon available
- Image `pgvector/pgvector:pg16` (pulled if missing)

Behavior:
- Ensures a container named `thefactory-db` exists and is running with:
  - `POSTGRES_USER=thefactory`, `POSTGRES_PASSWORD=thefactory`, `POSTGRES_DB=thefactorydb`
  - Host port mapping prefers 5435 -> 5432; if 5435 is occupied, the first free port is used (Docker persists the mapping)
- Returns `{ connectionString, created }` where `created` is true only on first creation
- After readiness, the schema is initialized once via `openDatabase()`; the connection is then closed
- Never drops data; repeated calls are idempotent

Example:

```ts
import { createReusableDatabase, openDatabase } from 'thefactory-db'

const { connectionString, created } = await createReusableDatabase()
console.log('DB ready at', connectionString, 'created:', created)

const db = await openDatabase({ connectionString })
// ... use db
await db.close()
```

Notes:
- Always use the returned connection string; if 5435 was busy during first creation, Docker may map a different host port.
- To remove this instance manually, stop and remove the `thefactory-db` container via Docker.

### Minimal API surface

- `createDatabase(options?: { connectionString?: string; logLevel?: LogLevel }): Promise<{ client: TheFactoryDb; connectionString: string; destroy: () => Promise<void>; isManaged: boolean; dbName: string }>`
  - Managed (default): starts a fresh container and returns a handle; `destroy()` stops/removes it
  - External: creates a temporary database on your server; `destroy()` drops that database
- `destroyDatabase(handle): Promise<void>`
  - Idempotent; safe to call multiple times
- `createReusableDatabase(options?: { logLevel?: LogLevel }): Promise<{ connectionString: string; created: boolean }>`
  - Idempotently provisions or starts a long-lived local Docker container and returns its connection string
- `openDatabase(options: { connectionString: string; logLevel?: LogLevel }): Promise<TheFactoryDb>` remains available for direct connections

Behavioral guarantees:
- Schema bootstrap: `openDatabase()` applies schema/extensions and hybrid search SQL automatically
- Readiness: managed flows wait for `SELECT 1` before returning
- Teardown: ephemeral flows fully remove their state (container or temp DB) when destroyed
- No optional toggles on ephemeral flows: no reuse, no isolation flags, no cleanup knobs

### Troubleshooting

- Docker unavailable or permission denied
  - Ensure Docker Desktop/daemon is running
  - On Linux, ensure your user has access to the Docker socket (e.g., add to `docker` group) and re-login
  - Test: `docker ps` should succeed

- Port 5435 already in use (reusable flow)
  - `createReusableDatabase()` prefers 5435 but will choose a free port if occupied; always use the returned `connectionString`
  - If you need 5435 specifically, stop the conflicting service/container and recreate/start the `thefactory-db` container

- Missing `pgvector` extension (external flow)
  - Error will mention failure to create/use extension `vector`
  - Install pgvector for your PostgreSQL server and enable it: `CREATE EXTENSION IF NOT EXISTS vector;`
  - Project: https://github.com/pgvector/pgvector

- Insufficient privileges (external flow)
  - The role must have `CREATEDB` to create the temporary database
  - The role must be able to create or use extension `vector` (often requires superuser or preinstalled extension in the template)

- Manage the reusable container manually
  - List: `docker ps -a | grep thefactory-db`
  - Logs: `docker logs thefactory-db`
  - Stop: `docker stop thefactory-db`
  - Remove: `docker rm thefactory-db`
  - After removal, the next `createReusableDatabase()` call will recreate it

Clarification: the reusable provisioning flow is separate from the ephemeral lifecycle. Ephemeral flows are always fresh and fully removed on destroy; the reusable flow is intentionally persistent and never auto-dropped by this package.
