import { readSql } from './utils.js'
import { Pool, PoolClient } from 'pg'

/**
 * Represents the raw database client from the `pg` library.
 */
export type DB = Pool

/**
 * Initializes the database schema by executing the necessary SQL scripts.
 * @param client - The database client to use for initialization.
 */
async function initSchema(client: PoolClient) {
  const schemaSql = readSql('schema')
  const hybridSql = readSql('hybridSearch')

  if (schemaSql) {
    await client.query(schemaSql)
  }
  if (hybridSql) {
    await client.query(hybridSql)
  }
}

/**
 * Opens a new PostgreSQL connection and initializes the schema.
 * @param connectionString - The PostgreSQL connection string.
 * @returns A promise that resolves to the connected and initialized database client.
 * @throws Will throw an error if the connection or schema initialization fails.
 */
export async function openPostgres(connectionString: string): Promise<DB> {
  // 1. Create a pool instead of a client
  const pool = new Pool({ connectionString })

  const client = await pool.connect()
  try {
    await initSchema(client)
  } catch (e) {
    await pool.end() // Close all connections in the pool if init fails
    throw e
  } finally {
    client.release()
  }

  return pool
}
