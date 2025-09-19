import { readSql } from './utils.js';
import { Client } from 'pg';

/**
 * Represents the raw database client from the `pg` library.
 */
export type DB = Client;

/**
 * Initializes the database schema by executing the necessary SQL scripts.
 * @param client - The database client to use for initialization.
 */
async function initSchema(client: DB) {
  const schemaSql = readSql('schema');
  const hybridSql = readSql('hybridSearch');

  if (schemaSql) {
    await client.query(schemaSql);
  }
  if (hybridSql) {
    await client.query(hybridSql);
  }
}

/**
 * Opens a new PostgreSQL connection and initializes the schema.
 * @param connectionString - The PostgreSQL connection string.
 * @returns A promise that resolves to the connected and initialized database client.
 * @throws Will throw an error if the connection or schema initialization fails.
 */
export async function openPostgres(connectionString: string): Promise<DB> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await initSchema(client);
  } catch (e) {
    await client.end(); // close connection if init fails
    throw e;
  }
  return client;
}
