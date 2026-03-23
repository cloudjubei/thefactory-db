import { Pool } from 'pg'
import { randomBytes } from 'crypto'
import type { LogLevel } from './types.js'
import type { TheFactoryDb } from './index.js'

// Testcontainers core for ephemeral managed DBs
import { GenericContainer, Wait, StartedTestContainer } from 'testcontainers'
// Dockerode for reusable managed DB provisioning
import Docker from 'dockerode'
import getPort from 'get-port'

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

async function waitForSelect1(
  connectionString: string,
  attempts = 30,
  delayMs = 500,
): Promise<void> {
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
      }
    } catch (e) {
      lastErr = e
      await new Promise((r) => setTimeout(r, delayMs))
    } finally {
      // Ensure we always close the pool, even when connect() fails.
      // Leaking pools/sockets can cause tests to hang under flaky startup conditions.
      try {
        await pool.end()
      } catch {
        // ignore
      }
    }
  }
  if (lastErr) throw lastErr
}

function buildPgUrl({
  host,
  port,
  user,
  password,
  db,
}: {
  host: string
  port: number
  user: string
  password: string
  db: string
}): string {
  const pw = encodeURIComponent(password)
  const usr = encodeURIComponent(user)
  return `postgresql://${usr}:${pw}@${host}:${port}/${db}`
}

function cloneUrlWithDb(u: URL, dbName: string): URL {
  const copy = new URL(u.toString())
  copy.pathname = `/${dbName}`
  return copy
}

function buildConnectionStringParts({
  host,
  port,
  user,
  password,
  db,
}: {
  host: string
  port: number
  user: string
  password: string
  db: string
}): string {
  const pw = encodeURIComponent(password)
  const usr = encodeURIComponent(user)
  return `postgresql://${usr}:${pw}@${host}:${port}/${db}`
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
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [h.dbName],
        )
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

export type CreateReusableDatabaseOptions = { logLevel?: LogLevel }

/**
 * Ensure a long-lived local Postgres+pgvector container exists and is running.
 * - image: 'pgvector/pgvector:pg16'
 * - container name: 'thefactory-db'
 * - env: POSTGRES_USER=thefactory, POSTGRES_PASSWORD=thefactory, POSTGRES_DB=thefactorydb
 * - port mapping: try 5435 -> 5432, otherwise first free port; mapping is persisted by Docker
 * - returns actual connection string and whether it was created in this call
 */
export async function createReusableDatabase(
  options?: CreateReusableDatabaseOptions,
): Promise<{ connectionString: string; created: boolean }> {
  const docker = new Docker()
  const image = 'pgvector/pgvector:pg16'
  const name = 'thefactory-db'
  const user = 'thefactory'
  const password = 'thefactory'
  const db = 'thefactorydb'

  // Helper to derive connection string from container inspect
  const getConnFromInspect = (info: any): string => {
    const portBindings = info?.NetworkSettings?.Ports?.['5432/tcp'] as
      | Array<{ HostIp: string; HostPort: string }>
      | undefined
    // dockerode sometimes returns an empty array briefly after start, or when a container
    // exists without a published host port (shouldn't happen for our created container,
    // but can happen if the container was created externally).
    const hostPort =
      portBindings && portBindings[0] && portBindings[0].HostPort
        ? Number(portBindings[0].HostPort)
        : undefined
    if (!hostPort || Number.isNaN(hostPort)) {
      throw new Error('Unable to determine mapped host port for reusable database container')
    }
    return buildConnectionStringParts({ host: 'localhost', port: hostPort, user, password, db })
  }

  // Find container by name (includes leading '/name' in Names array)
  const existingList = await docker.listContainers({ all: true, filters: { name: [name] } as any })
  const existingInfo = existingList.find((c) => (c.Names || []).some((n) => n === `/${name}`))
  let container = existingInfo ? docker.getContainer(existingInfo.Id) : undefined

  if (container) {
    const inspect = await container.inspect()
    const running = inspect?.State?.Running
    if (!running) {
      await container.start()
    }
    // Re-inspect after ensuring it's started; port bindings may not be populated
    // in the first inspect call.
    const inspect2 = await container.inspect()
    const connectionString = getConnFromInspect(inspect2)
    if (!running) {
      await waitForSelect1(connectionString)
    }
    return { connectionString, created: false }
  }

  // Pull image if not present
  const images = await docker.listImages({ filters: { reference: [image] } as any })
  if (!images || images.length === 0) {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: any, stream: any) => {
        if (err) return reject(err)
        try {
          stream.on('end', () => resolve())
          stream.on('error', (e: any) => reject(e))
          // drain stream to ensure events fire
          stream.resume?.()
        } catch (e) {
          resolve() // best-effort
        }
      })
    })
  }

  // Port strategy: prefer 5435, otherwise first available
  const preferred = 5435
  const hostPort = await getPort({ port: preferred })

  // Create container with deterministic name and env
  container = await docker.createContainer({
    name,
    Image: image,
    Env: [`POSTGRES_USER=${user}`, `POSTGRES_PASSWORD=${password}`, `POSTGRES_DB=${db}`],
    ExposedPorts: { '5432/tcp': {} },
    HostConfig: {
      PortBindings: { '5432/tcp': [{ HostPort: String(hostPort) }] },
    },
  })

  await container.start()

  // Inspect to confirm mapping (source of truth)
  const inspect = await container.inspect()
  const connectionString = getConnFromInspect(inspect)

  // Readiness guard
  await waitForSelect1(connectionString)

  // Initialize schema once via openDatabase(), then close immediately
  const { openDatabase } = await import('./index.js')
  const client = await openDatabase({ connectionString, logLevel: options?.logLevel })
  await client.close()

  return { connectionString, created: true }
}
