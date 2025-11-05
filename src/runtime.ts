import { Pool } from 'pg'
import { randomBytes } from 'crypto'
import type { LogLevel } from './types.js'
import type { TheFactoryDb } from './index.js'

// Testcontainers core
import { GenericContainer, Wait, StartedTestContainer } from 'testcontainers'

export type CreateDatabaseOptions = {
  connectionString?: string
  logLevel?: LogLevel
}

export type DatabaseHandle = {
  client: TheFactoryDb
  connectionString: string
  destroy: () => Promise<void>
  isManaged: boolean
  dbName: string
}

// Internal tracking for cleanup of managed containers on process exit
const managedHandles = new Set<InternalHandle>()
let cleanupHandlersRegistered = false

function registerCleanupHandlers() {
  if (cleanupHandlersRegistered) return
  cleanupHandlersRegistered = true
  const cleanup = async () => {
    const promises: Promise<void>[] = []
    for (const h of managedHandles) {
      promises.push(safeDestroy(h))
    }
    try {
      await Promise.allSettled(promises)
    } catch {
      // ignore
    }
  }
  process.once('SIGINT', () => void cleanup())
  process.once('SIGTERM', () => void cleanup())
}

function randHex(nBytes: number): string {
  return randomBytes(nBytes).toString('hex')
}

async function waitForSelect1(connectionString: string, attempts = 30, delayMs = 500): Promise<void> {
  let lastErr: any
  for (let i = 0; i < attempts; i++) {
    const pool = new Pool({ connectionString })
    try {
      const client = await pool.connect()
      try {
        await client.query('SELECT 1')
        return
      } finally {
        client.release()
        await pool.end()
      }
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  if (lastErr) throw lastErr
}

function buildPgUrl({ host, port, user, password, db }: { host: string; port: number; user: string; password: string; db: string }): string {
  const pw = encodeURIComponent(password)
  const usr = encodeURIComponent(user)
  return `postgresql://${usr}:${pw}@${host}:${port}/${db}`
}

function cloneUrlWithDb(u: URL, dbName: string): URL {
  const copy = new URL(u.toString())
  copy.pathname = `/${dbName}`
  return copy
}

// Internal handle with implementation details for teardown
type InternalHandle = DatabaseHandle & {
  __internal: {
    destroyed: boolean
    managed?: {
      container: StartedTestContainer
    }
    external?: {
      adminUrl: string
    }
  }
}

async function safeDestroy(h: InternalHandle): Promise<void> {
  if (h.__internal.destroyed) return
  h.__internal.destroyed = true
  try {
    await h.client.close()
  } catch {
    // ignore
  }
  if (h.__internal.managed) {
    try {
      await h.__internal.managed.container.stop()
    } catch {
      // ignore container stop errors
    } finally {
      managedHandles.delete(h)
    }
  } else if (h.__internal.external) {
    // Connect to admin DB and drop the temp database
    try {
      const adminPool = new Pool({ connectionString: h.__internal.external.adminUrl })
      try {
        // Ensure no lingering connections
        await adminPool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`, [h.dbName])
        await adminPool.query(`DROP DATABASE IF EXISTS "${h.dbName}"`)
      } finally {
        await adminPool.end()
      }
    } catch {
      // ignore
    }
  }
}

export async function createDatabase(opts?: CreateDatabaseOptions): Promise<DatabaseHandle> {
  const logLevel = opts?.logLevel
  if (!opts?.connectionString) {
    // Managed mode via Testcontainers
    registerCleanupHandlers()

    const dbName = `tfdb_${randHex(6)}`
    const user = `u_${randHex(4)}`
    const password = randHex(12)

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
    const connectionString = buildPgUrl({ host, port, user, password, db: dbName })

    // Readiness guard
    await waitForSelect1(connectionString)

    const { openDatabase } = await import('./index.js')
    const client = await openDatabase({ connectionString, logLevel })

    const handle: InternalHandle = {
      client,
      connectionString,
      isManaged: true,
      dbName,
      destroy: async () => safeDestroy(handle),
      __internal: {
        destroyed: false,
        managed: { container },
      },
    }

    managedHandles.add(handle)
    return handle
  } else {
    // External mode: create temp database on provided server
    const baseUrl = new URL(opts.connectionString)
    // Admin operations go to 'postgres' database
    const adminUrl = cloneUrlWithDb(baseUrl, 'postgres').toString()

    const dbName = `tfdb_${randHex(6)}`

    // Create DB
    const adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query(`CREATE DATABASE "${dbName}"`)
    } finally {
      await adminPool.end()
    }

    const dbUrl = cloneUrlWithDb(baseUrl, dbName).toString()

    // Readiness (server already up; new DB ready upon creation)
    await waitForSelect1(dbUrl)

    const { openDatabase } = await import('./index.js')
    const client = await openDatabase({ connectionString: dbUrl, logLevel })

    const handle: InternalHandle = {
      client,
      connectionString: dbUrl,
      isManaged: false,
      dbName,
      destroy: async () => safeDestroy(handle),
      __internal: {
        destroyed: false,
        external: { adminUrl },
      },
    }

    return handle
  }
}

export async function destroyDatabase(handle: DatabaseHandle): Promise<void> {
  const h = handle as InternalHandle
  await safeDestroy(h)
}
