import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import { Pool } from 'pg'
import crypto from 'node:crypto'
import { URL } from 'node:url'
import type { LogLevel } from './types.js'
import type { TheFactoryDb } from './index.js'
import Docker from 'dockerode'
import type { ContainerCreateOptions, ContainerInspectInfo, ContainerInfo } from 'dockerode'
import getPort from 'get-port'

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
      throw new Error('Initialization failed: pgvector extension (\'vector\') is not available on the server. Install pgvector on the server or use managed mode.')
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

  const docker = new Docker()

  // Find existing container by name
  const containerInfo = await findContainerByName(docker, name)
  if (containerInfo) {
    const container = docker.getContainer(containerInfo.Id)
    const inspect = await container.inspect()
    const running = inspect.State?.Running === true
    const hostPort = getMappedHostPort(inspect, 5432)
    if (!hostPort) {
      throw new Error('Existing container has no host port mapping for 5432/tcp')
    }
    const connectionString = buildPgUrl({ user, password, host: 'localhost', port: hostPort, db: dbName })

    if (!running) {
      await container.start()
      await waitForReady(connectionString)
    }

    // Do not re-run schema init for existing container; it is idempotent but unnecessary
    return { connectionString, created: false }
  }

  // Ensure image is available (pull if necessary)
  await ensureImage(docker, image)

  // Prefer host port 5435; if unavailable, choose the first free port
  const preferred = 5435
  const selectedPort = await getPort({ port: preferred })

  const createOptions: ContainerCreateOptions = {
    name,
    Image: image,
    Env: [
      `POSTGRES_USER=${user}`,
      `POSTGRES_PASSWORD=${password}`,
      `POSTGRES_DB=${dbName}`,
    ],
    ExposedPorts: {
      '5432/tcp': {},
    },
    HostConfig: {
      PortBindings: {
        '5432/tcp': [
          {
            HostPort: String(selectedPort),
          },
        ],
      },
    },
  }

  const container = await docker.createContainer(createOptions)
  await container.start()

  // Re-inspect to obtain actual mapped port (Docker should respect explicit binding)
  const inspect = await container.inspect()
  const hostPort = getMappedHostPort(inspect, 5432)
  if (!hostPort) throw new Error('Failed to determine mapped host port for container')

  const connectionString = buildPgUrl({ user, password, host: 'localhost', port: hostPort, db: dbName })

  await waitForReady(connectionString)

  // Initialize schema once on first creation
  const { openDatabase } = await import('./index.js')
  const db = await openDatabase({ connectionString, logLevel })
  await db.close()

  return { connectionString, created: true }
}

function getMappedHostPort(inspect: ContainerInspectInfo, containerPort: number): number | undefined {
  const key = `${containerPort}/tcp`
  const ports = inspect?.NetworkSettings?.Ports?.[key]
  if (!ports || ports.length === 0) return undefined
  const hp = ports[0]?.HostPort
  if (!hp) return undefined
  const parsed = Number.parseInt(hp, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

async function findContainerByName(docker: Docker, name: string): Promise<ContainerInfo | undefined> {
  const list = await docker.listContainers({ all: true, filters: { name: [name] } as any })
  return list.find((c) => c.Names?.some((n) => n === `/${name}`))
}

async function ensureImage(docker: Docker, image: string): Promise<void> {
  try {
    // Try to inspect image; if it exists, return
    await docker.getImage(image).inspect()
    return
  } catch {
    // pull image
    const stream = await docker.pull(image)
    await new Promise<void>((resolve, reject) => {
      ;(docker as any).modem.followProgress(stream, (err: any) => (err ? reject(err) : resolve()))
    })
  }
}
