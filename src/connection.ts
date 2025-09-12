import { Pool } from 'pg';
import { readSql } from './utils.js';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Pool;

let poolCache: Map<string, Pool> = new Map();

// Embedded server cache keyed by data dir to avoid multiple instances
const embeddedUrlByDir = new Map<string, string>();
// Track embedded instance objects to allow graceful shutdown
const embeddedInstanceByDir = new Map<string, any>();

export interface OpenOptions {
  connectionString?: string;
  databaseDir?: string; // when provided, boot an embedded postgres instance
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

function defaultDataDir(): string {
  // Place in project cwd by default
  const cwd = process.cwd();
  return path.resolve(cwd, '.thefactory-db/pgdata');
}

export async function ensureEmbeddedPostgres(databaseDir?: string): Promise<string> {
  // Dynamically import to avoid loading when not needed
  const { PgEmbedded } = await import('pg-embedded');

  const baseDir = path.resolve(databaseDir || defaultDataDir());
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const cached = embeddedUrlByDir.get(baseDir);
  if (cached) return cached;

  // Create and start embedded PostgreSQL
  // PgEmbedded accepts a config object; keep defaults sensible
  const pg = new (PgEmbedded as any)({
    baseDir,
    // default values; library picks a random open port if not provided
    // You can customize database/user/password if needed
    database: 'thefactory',
    username: 'postgres',
    password: 'postgres',
    keepGoing: true,
  });

  if (typeof pg.init === 'function') {
    await pg.init();
  }
  if (typeof pg.start === 'function') {
    await pg.start();
  }

  // Try known getters for connection string depending on lib version
  let url: string | undefined;
  if (typeof pg.getConnectionString === 'function') {
    url = pg.getConnectionString();
  } else if (typeof pg.getDBUri === 'function') {
    url = pg.getDBUri();
  } else if (typeof pg.getUri === 'function') {
    url = pg.getUri();
  } else if (typeof pg.getUrl === 'function') {
    url = pg.getUrl();
  }
  if (!url) {
    // Fallback: construct from known props
    const port = pg.port ?? pg.getPort?.() ?? 5432;
    const user = pg.username ?? 'postgres';
    const pass = pg.password ?? 'postgres';
    const db = pg.database ?? 'thefactory';
    url = `postgres://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@localhost:${port}/${db}`;
  }

  embeddedUrlByDir.set(baseDir, url);
  embeddedInstanceByDir.set(baseDir, pg);
  return url;
}

export async function openPostgres({ connectionString, databaseDir }: OpenOptions): Promise<Pool> {
  let url = connectionString;
  if (!url) {
    // When a databaseDir is provided (or default), start embedded Postgres
    url = await ensureEmbeddedPostgres(databaseDir);
  }
  if (!url) throw new Error('openPostgres: either connectionString or databaseDir must be provided');

  const key = url;
  let pool = poolCache.get(key);
  if (pool) return pool;

  pool = new Pool({ connectionString: url });
  await initSchema(pool);
  poolCache.set(key, pool);
  return pool;
}

// Close a pg.Pool and remove it from cache
export async function closePostgres(pool: Pool): Promise<void> {
  try {
    await pool.end();
  } finally {
    // Remove from cache by identity
    for (const [key, value] of poolCache.entries()) {
      if (value === pool) {
        poolCache.delete(key);
        break;
      }
    }
  }
}

// Gracefully shut down an embedded Postgres instance for the given data dir (or default)
export async function shutdownEmbeddedPostgres(databaseDir?: string): Promise<void> {
  const baseDir = path.resolve(databaseDir || defaultDataDir());
  const instance = embeddedInstanceByDir.get(baseDir);
  if (!instance) {
    // Nothing to do
    embeddedUrlByDir.delete(baseDir);
    return;
  }
  try {
    if (typeof instance.stop === 'function') {
      await instance.stop();
    } else if (typeof instance.down === 'function') {
      // some versions may use down()
      await instance.down();
    }
  } catch {}
  try {
    if (typeof instance.cleanup === 'function') {
      await instance.cleanup();
    } else if (typeof instance.clean === 'function') {
      await instance.clean();
    }
  } catch {}
  embeddedInstanceByDir.delete(baseDir);
  embeddedUrlByDir.delete(baseDir);
}
