import { readSql } from './utils.js';
import pg from 'pg';

export type DB = pg.Client;

async function initSchema(client: DB) {
  const schemaSql = readSql('schema');
  const hybridSql = readSql('hybrid_search');

  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');

  if (schemaSql) {
    await client.query(schemaSql);
  }
  if (hybridSql) {
    await client.query(hybridSql);
  }
}

export async function openPostgres(connectionString: string): Promise<DB> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await initSchema(client);
  } catch (e) {
    await client.end(); // close connection if init fails
    throw e;
  }
  return client;
}
