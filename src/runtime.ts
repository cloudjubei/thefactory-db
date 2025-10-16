import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import { Pool } from 'pg'
import crypto from 'node:crypto'
import { URL } from 'node:url'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import type { LogLevel } from './types.js'
import type { TheFactoryDb } from './index.js'

const exec = promisify(execCb)

export type CreateDatabaseOptions = { connectionString?: string; logLevel?: LogLevel }

type ManagedHandle = {
  mode: 'managed'
  container: StartedTestContainer
  connectionString: string
  dbName: string
  client?: TheFactoryDb
  destroyed?: boolean
}

type ExternalHandle = {
  mode: 'external'
  adminUrl: string
  connectionString: string
  dbName: string
  client?: TheFactoryDb
  destroyed?: boolean
}

export type DatabaseHandle = ManagedHandle | ExternalHandle

const startedManaged: Set<ManagedHandle> = new Set()
let exitHooksRegistered = false

function randomHex(n: number): string {
  return crypto.randomBytes(n).toString('hex')
}

function buildPgUrl({ user, password, host, port, db }: { user: string; password: string; host: string; port: number; db: string }): string {
  const encUser = encodeURIComponent(user)
  const encPass = encodeURIComponent(password)
  return `postgresql://${encUser}:${encPass}@${host}:${port}/${db}`
}

async function waitForReady(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString })
  try {
    // retry loop in case PG is accepting TCP but not ready for queries
    const start = Date.now()
    const timeoutMs = 30_000
    let lastErr: unknown
    while (Date.now() - start < timeoutMs) {
      try {
        const r = await pool.query('SELECT 1 as ok')
        if (r.rows?.[0]?.ok === 1) return
      } catch (e) {
        lastErr = e
      }
      await new Promise((res) => setTimeout(res, 300))
    }
    throw lastErr ?? new Error('database readiness timeout')
  } finally {
    await pool.end().catch(() => {})
  }
}

function registerExitHooks() {
  if (exitHooksRegistered) return
  const shutdown = async () => {
    const handles = Array.from(startedManaged)
    for (const h of handles) {
      try {
        await destroyDatabase(h)
      } catch {
        // ignore
      }
    }
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
  process.once('beforeExit', shutdown)
  exitHooksRegistered = true
}

export async function createDatabase(opts?: CreateDatabaseOptions): Promise<{
  client: TheFactoryDb
  connectionString: string
  destroy: () => Promise<void>
  isManaged: boolean
  dbName: string
  handle: DatabaseHandle
}> {
  const logLevel = opts?.logLevel
  const { openDatabase } = await import('./index.js')

  // Managed mode (default): spin up ephemeral container
  if (!opts?.connectionString) {
    const user = `u_${randomHex(6)}`
    const password = randomHex(12)
    const dbName = `db_${randomHex(6)}`

    const container = await new GenericContainer('pgvector/pgvector:pg16')
      .withEnvironment({
        POSTGRES_USER: user,
        POSTGRES_PASSWORD: password,
        POSTGRES_DB: dbName,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forListeningPorts())
      .start()

    const host = container.getHost()
    const port = container.getMappedPort(5432)
    const connectionString = buildPgUrl({ user, password, host, port, db: dbName })

    // extra readiness check
    await waitForReady(connectionString)

    const client = await openDatabase({ connectionString, logLevel })

    const handle: ManagedHandle = {
      mode: 'managed',
      container,
      connectionString,
      dbName,
      client,
      destroyed: false,
    }

    startedManaged.add(handle)
    registerExitHooks()

    const destroy = async () => destroyDatabase(handle)

    return { client, connectionString, destroy, isManaged: true, dbName, handle }
  }

  // External mode: create a temporary database on provided server
  const original = new URL(opts.connectionString)
  const adminUrl = new URL(opts.connectionString)
  // connect to admin DB (postgres) for CREATE/DROP DATABASE
  adminUrl.pathname = '/postgres'

  const dbName = `tfdb_${randomHex(6)}`

  // Create database
  const adminPool = new Pool({ connectionString: adminUrl.toString() })
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`)
  } catch (e: any) {
    if (e?.message?.includes('permission') || e?.code === '42501') {
      throw new Error('createDatabase failed: role lacks CREATEDB privilege on the server. Ensure the provided user can CREATE DATABASE.')
    }
    throw e
  } finally {
    await adminPool.end().catch(() => {})
  }

  const dbUrl = new URL(original.toString())
  dbUrl.pathname = `/${dbName}`
  const connectionString = dbUrl.toString()

  // Validate readiness and init schema
  await waitForReady(connectionString)
  let client: TheFactoryDb
  try {
    const { openDatabase } = await import('./index.js')
    client = await openDatabase({ connectionString, logLevel })
  } catch (e: any) {
    // Common case: vector extension not available
    if (e?.message?.includes('extension') && e?.message?.includes('vector')) {
      throw new Error('Initialization failed: pgvector extension ("vector") is not available on the server. Install pgvector on the server or use managed mode.')
    }
    throw e
  }

  const handle: ExternalHandle = {
    mode: 'external',
    adminUrl: adminUrl.toString(),
    connectionString,
    dbName,
    client,
    destroyed: false,
  }

  const destroy = async () => destroyDatabase(handle)

  return { client, connectionString, destroy, isManaged: false, dbName, handle }
}

export async function destroyDatabase(handle: DatabaseHandle | { destroy: () => Promise<void> }): Promise<void> {
  // Support convenience handle with destroy()
  if ((handle as any).destroy && typeof (handle as any).destroy === 'function' && !(handle as any).mode) {
    return (handle as any).destroy()
  }

  const h = handle as DatabaseHandle
  if (h.destroyed) return

  try {
    await h.client?.close().catch(() => {})
  } catch {
    // ignore
  }

  if (h.mode === 'managed') {
    try {
      await h.container?.stop({ timeout: 5_000 })
    } catch {
      // ignore
    } finally {
      startedManaged.delete(h)
    }
  } else {
    // external: drop database by connecting to admin DB
    const pool = new Pool({ connectionString: h.adminUrl })
    try {
      // terminate existing connections to allow drop
      await pool.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [h.dbName],
      )
      await pool.query(`DROP DATABASE IF EXISTS "${h.dbName}"`)
    } finally {
      await pool.end().catch(() => {})
    }
  }
  h.destroyed = true
}

// Reusable persistent local database provisioning via Docker (name: thefactory-db)
export async function createReusableDatabase(options?: { logLevel?: LogLevel }): Promise<{ connectionString: string; created: boolean }> {
  const logLevel = options?.logLevel
  const name = 'thefactory-db'
  const image = 'pgvector/pgvector:pg16'
  const user = 'thefactory'
  const password = 'thefactory'
  const dbName = 'thefactorydb'
  const hostPort = 5435
  const connectionString = buildPgUrl({ user, password, host: '127.0.0.1', port: hostPort, db: dbName })

  // Check if container exists
  const exists = await containerExistsByName(name)
  if (exists) {
    const running = await containerRunningByName(name)
    if (!running) {
      await dockerStart(name)
      await waitForReady(connectionString)
    }
    // Ensure schema is initialized once (idempotent)
    const { openDatabase } = await import('./index.js')
    const db = await openDatabase({ connectionString, logLevel })
    await db.close()
    return { connectionString, created: false }
  }

  // Create container with fixed host port mapping using Docker CLI
  await exec(
    [
      'docker run -d',
      `--name ${name}`,
      '-e', `POSTGRES_USER=${user}`,
      '-e', `POSTGRES_PASSWORD=${password}`,
      '-e', `POSTGRES_DB=${dbName}`,
      '-p', `${hostPort}:5432`,
      image,
    ].join(' '),
  )

  await waitForReady(connectionString)
  const { openDatabase } = await import('./index.js')
  const db = await openDatabase({ connectionString, logLevel })
  await db.close()
  return { connectionString, created: true }
}

async function containerExistsByName(name: string): Promise<boolean> {
  try {
    await exec(`docker inspect ${name}`)
    return true
  } catch {
    return false
  }
}

async function containerRunningByName(name: string): Promise<boolean> {
  try {
    const { stdout } = await exec(`docker inspect -f '{{.State.Running}}' ${name}`)
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function dockerStart(name: string): Promise<void> {
  await exec(`docker start ${name}`)
}
