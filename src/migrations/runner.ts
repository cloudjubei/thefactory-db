import { Pool, PoolClient } from 'pg'
import type { OpenDbOptions } from '../types.js'
import { createLogger } from '../logger.js'
import { migrations } from './index.js'

// Hash string for pg_advisory_lock
// Using hashtext('thefactory-db:migrations') -> 2088891632
const LOCK_ID = 2088891632

export type MigrateOptions = {
  toVersion?: number
  dryRun?: boolean
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent'
}

export type DatabaseInfo = {
  schemaVersion: number
  latestVersion: number
  pending: Array<{ id: string; version: number }>
}

function isPool(obj: any): obj is Pool {
  return obj && typeof obj.connect === 'function' && typeof obj.query === 'function' && typeof obj.end === 'function'
}

async function ensureMetadata(client: PoolClient) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS thefactory;`)
  await client.query(`
    CREATE TABLE IF NOT EXISTS thefactory.meta (
      schema_version integer not null,
      updated_at timestamptz not null default now()
    );
  `)
  await client.query(`
    CREATE TABLE IF NOT EXISTS thefactory.migration_log (
      version integer primary key,
      id text not null,
      applied_at timestamptz not null default now()
    );
  `)

  const res = await client.query(`SELECT schema_version FROM thefactory.meta LIMIT 1;`)
  if (res.rowCount === 0) {
    await client.query(`INSERT INTO thefactory.meta (schema_version) VALUES (0);`)
  }
}

export async function getDatabaseInfo(dbOrConfig: Pool | OpenDbOptions): Promise<DatabaseInfo> {
  const pool = isPool(dbOrConfig) ? dbOrConfig : new Pool({ connectionString: (dbOrConfig as OpenDbOptions).connectionString })

  try {
    const client = await pool.connect()
    try {
      await ensureMetadata(client)
      const res = await client.query(`SELECT schema_version FROM thefactory.meta LIMIT 1;`)
      const schemaVersion = res.rows[0]?.schema_version ?? 0

      const latestVersion = migrations.length > 0 ? migrations[migrations.length - 1].version : 0
      const pending = migrations
        .filter((m) => m.version > schemaVersion)
        .map((m) => ({ id: m.id, version: m.version }))

      return { schemaVersion, latestVersion, pending }
    } finally {
      client.release()
    }
  } finally {
    if (!isPool(dbOrConfig)) {
      await pool.end()
    }
  }
}

async function acquireLock(client: PoolClient): Promise<boolean> {
  const timeoutMs = parseInt(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? '30000', 10)
  const retryMs = parseInt(process.env.MIGRATION_LOCK_RETRY_MS ?? '100', 10)

  const start = Date.now()
  let delay = retryMs
  while (Date.now() - start < timeoutMs) {
    const res = await client.query(`SELECT pg_try_advisory_lock($1) as acquired`, [LOCK_ID])
    if (res.rows[0].acquired) {
      return true
    }
    await new Promise((r) => setTimeout(r, delay))
    delay = Math.min(delay * 1.5, 2000)
  }
  return false
}

export async function migrateDatabase(dbOrConfig: Pool | OpenDbOptions, options?: MigrateOptions): Promise<void> {
  const logger = createLogger(options?.logLevel)
  const pool = isPool(dbOrConfig) ? dbOrConfig : new Pool({ connectionString: (dbOrConfig as OpenDbOptions).connectionString })

  try {
    const lockClient = await pool.connect()
    try {
      logger.debug('Acquiring migration lock...')
      const acquired = await acquireLock(lockClient)
      if (!acquired) {
        throw new Error('Failed to acquire migration lock within timeout')
      }

      try {
        await ensureMetadata(lockClient)
        const res = await lockClient.query(`SELECT schema_version FROM thefactory.meta LIMIT 1;`)
        const currentVersion = res.rows[0]?.schema_version ?? 0

        const targetVersion = options?.toVersion ?? (migrations.length > 0 ? migrations[migrations.length - 1].version : 0)

        const pending = migrations.filter((m) => m.version > currentVersion && m.version <= targetVersion)

        if (pending.length === 0) {
          logger.debug(`Database is up to date (version ${currentVersion})`)
          return
        }

        logger.info(`Found ${pending.length} pending migrations.`)

        for (const m of pending) {
          if (options?.dryRun) {
            logger.info(`[Dry Run] Would apply migration ${m.version}: ${m.id}`)
            continue
          }

          logger.info(`Applying migration ${m.version}: ${m.id}`)

          await lockClient.query('BEGIN')
          try {
            await m.up({ db: pool, client: lockClient })
            await lockClient.query(`INSERT INTO thefactory.migration_log (version, id) VALUES ($1, $2)`, [m.version, m.id])
            await lockClient.query(`UPDATE thefactory.meta SET schema_version = $1, updated_at = now()`, [m.version])
            await lockClient.query('COMMIT')
            logger.info(`Migration ${m.version} applied successfully.`)
          } catch (e) {
            await lockClient.query('ROLLBACK')
            logger.error(`Migration ${m.version} failed:`, e)
            throw new Error(`Migration failed at version ${m.version} (${m.id})`, { cause: e })
          }
        }
      } finally {
        await lockClient.query(`SELECT pg_advisory_unlock($1)`, [LOCK_ID])
      }
    } finally {
      lockClient.release()
    }
  } finally {
    if (!isPool(dbOrConfig)) {
      await pool.end()
    }
  }
}
