import { Pool, PoolClient } from 'pg'

/**
 * Represents the raw database client from the `pg` library.
 */
export type DB = Pool

/**
 * Opens a new PostgreSQL connection pool and verifies connectivity.
 * @param connectionString - The PostgreSQL connection string.
 * @returns A promise that resolves to the connected pool.
 * @throws Will throw an error if the connection fails.
 */
export async function openPostgres(connectionString: string): Promise<DB> {
  const pool = new Pool({ connectionString })

  const client = await pool.connect()
  try {
    await verifyConnection(client)
  } catch (e) {
    await pool.end()
    throw e
  } finally {
    client.release()
  }

  return pool
}

/**
 * Verifies that a database client can reach the server by issuing a
 * lightweight no-op query. Used during pool initialisation to fail fast
 * on bad credentials or unreachable hosts before any real work begins.
 */
async function verifyConnection(client: PoolClient): Promise<void> {
  await client.query('SELECT 1')
}
