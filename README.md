# thefactory-db

`thefactory-db` is a standalone, local-first PostgreSQL package with FTS text search (tsvector) and vector similarity (pgvector) for hybrid search across files and documents.

It is designed to be reusable across projects. You can depend on it as a local file dependency (`"thefactory-db": "file:../thefactory-db"`) or publish it to a private registry.

Database connection is provided via a Postgres connection string.

## Setup

To use `thefactory-db`, you need a running PostgreSQL instance with the `pgvector` extension enabled. You have two options:

### Option 1: Local PostgreSQL Installation

1.  **Install PostgreSQL**: Follow the official guides for your operating system:
    - [macOS](https://www.postgresql.org/docs/current/tutorial-install.html) (e.g., via `brew install postgresql`)
    - [Windows](https://www.postgresql.org/docs/current/tutorial-install.html) (use the installer)
    - [Linux](https://www.postgresql.org/docs/current/tutorial-install.html) (e.g., `sudo apt-get install postgresql postgresql-contrib`)

2.  **Start PostgreSQL**: Ensure the PostgreSQL service is running.

3.  **Create a database and user**:
    - Open the PostgreSQL command-line tool (`psql`).
    - Run the following SQL commands:

    ```sql
    CREATE DATABASE thefactory-db;
    CREATE USER "user" WITH ENCRYPTED PASSWORD 'password';
    GRANT ALL PRIVILEGES ON DATABASE thefactory-db TO "user";
    ```

    - Connect to your new database: `\c thefactory-db`

4.  **Enable the vector extension**:
    - You need to install `pgvector`. Follow the instructions for your OS from the [pgvector GitHub repository](https://github.com/pgvector/pgvector).
    - Once installed, connect to your database (`psql -d thefactory-db`) and run:

    ```sql
    CREATE EXTENSION IF NOT EXISTS vector;
    ```

5.  **Set your connection URL**: Your database connection string will be:
    `postgresql://user:password@localhost:5432/thefactory-db`

### Option 2: Docker

If you have Docker and Docker Compose installed, you can easily set up a PostgreSQL instance with `pgvector`.

1.  **Use the `docker-compose.yml` file**: This repository includes a `docker-compose.yml` file for your convenience.

2.  **Start the container**:
    Run the following command in the same directory as your `docker-compose.yml` file:

    ```bash
    docker compose up --build
    ```

    This will start a PostgreSQL container in the background. The `pgvector` extension is automatically available in the `pgvector/pgvector` image.

3.  **Connection URL**: The database will be available at:
    `postgresql://user:password@localhost:5432/thefactory-db`

## Populating the Database

Once your database is running, you can use the populate script to initialize the schema and ingest files.

1.  **Install dependencies:** `npm install`

2.  **Run the populate script:** This will initialize the database, ingest files from `src/` and `docs/`, and run a sample hybrid search query.

    ```bash
    node scripts/populate.ts -- --root . --reset --url postgresql://user:password@localhost:5432/thefactory-db
    ```

See `scripts/populate.ts` for details on command-line flags. The script uses the `DATABASE_URL` by default.

## Usage

```typescript
import { openDatabase } from 'thefactory-db'

// Set DATABASE_URL in your environment or provide it directly
const db = await openDatabase({ connectionString: process.env.DATABASE_URL })

// Add an entity
const entity = await db.addEntity({
  type: 'internal_document',
  content: 'This is a test document about hybrid search.',
  metadata: { author: 'dev' },
})

// Perform a hybrid search
const results = await db.searchEntities({
  query: 'hybrid search test',
  textWeight: 0.6, // Blend text and vector scores
  limit: 5,
})

console.log(results)
```

The `openDatabase` function will:

1.  Connect to your PostgreSQL database.
2.  Apply the latest schema from `docs/sql/schema.pg.sql`.
3.  Ensure the `vector` extension is enabled.

The returned `db` object provides an API for adding and searching entities, as well as a `raw()` method for direct `pg.Pool` access.
