import { readSql } from './utils.js';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import EmbeddedPostgres from 'embedded-postgres';

export type DB = pg.Client

const embeddedInstanceByDir = new Map<string, DB>();
const embeddedServerByDir = new Map<string, EmbeddedPostgres>();

export interface OpenOptions {
  connectionString?: string;
  databaseDir?: string; // when provided, boot an embedded postgres instance
}

async function initSchema(pg: EmbeddedPostgres) {
  const schemaSql = readSql('schema');
  const hybridSql = readSql('hybrid_search');
  const client = pg.getPgClient();
  await client.connect();
  if (!schemaSql) return client;

  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(schemaSql);
    if (hybridSql) {
      await client.query(hybridSql);
    }
  } finally {
    // client.release();
  }
  return client
}

function defaultDataDir(): string {
  // Place in project cwd by default
  const cwd = process.cwd();
  return path.resolve(cwd, '.thefactory-db/pgdata');
}

function getBaseDir(databaseDir?: string) : string
{
  return path.resolve(databaseDir || defaultDataDir());
}

export async function ensureEmbeddedPostgres(databaseDir?: string): Promise<DB> {
  const baseDir = getBaseDir(databaseDir);
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  const cached = embeddedInstanceByDir.get(baseDir);
  if (cached) return cached;

  const pg = new EmbeddedPostgres({
      databaseDir: baseDir,
      user: 'postgres',
      password: 'password',
      port: 5432,
      persistent: true,
  });

  await pg.initialise();
  await pg.start();

  const client = await initSchema(pg);

  embeddedServerByDir.set(baseDir, pg);
  embeddedInstanceByDir.set(baseDir, client)

  return client;
}

export async function openPostgres(databaseDir: string): Promise<DB> {
  return await ensureEmbeddedPostgres(databaseDir);
}

// Close a pg.Pool and remove it from cache
export async function closePostgres(db: DB, databaseDir?: string): Promise<void> {
  try {
    await db.end()
    // await db.stop();
  } finally {
    const baseDir = getBaseDir(databaseDir);
    embeddedInstanceByDir.delete(baseDir);
    for (const [key, value] of embeddedInstanceByDir.entries()) {
      if (value === db) {
        embeddedInstanceByDir.delete(key);
        break;
      }
    }
  }
}

export async function shutdownEmbeddedPostgres(databaseDir?: string): Promise<void> {
  const baseDir = getBaseDir(databaseDir);
  const instance = embeddedInstanceByDir.get(baseDir);
  if (instance) {
    await closePostgres(instance, databaseDir)
  }
  const pg = embeddedServerByDir.get(baseDir)
  if (pg){
    await pg.stop();
  }
  embeddedInstanceByDir.delete(baseDir);
}
