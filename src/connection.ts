import { Pool } from 'pg';
import { readSql } from './utils.js';

export type DB = Pool;

let poolCache: Map<string, Pool> = new Map();

export interface OpenOptions {
  connectionString: string;
}

async function initSchema(pool: Pool) {
  const schemaSql = readSql('schema');
  const hybridSql = readSql('hybrid_search');
  if (!schemaSql) return;
  const client = await pool.connect();
  try {
    // Ensure required extensions
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(schemaSql);
    if (hybridSql) {
      await client.query(hybridSql);
    }
  } finally {
    client.release();
  }
}

export async function openPostgres({ connectionString }: OpenOptions): Promise<Pool> {
  if (!connectionString) throw new Error('openPostgres: connectionString is required');
  const key = connectionString;
  let pool = poolCache.get(key);
  if (pool) return pool;

  pool = new Pool({ connectionString });
  await initSchema(pool);
  poolCache.set(key, pool);
  return pool;
}
