import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---- Shared hoisted state for mocks ----
const dockerHoisted = vi.hoisted(() => ({
  dockerInstance: {} as any,
}))

const tcHoisted = vi.hoisted(() => {
  const container = {
    getHost: vi.fn(() => 'localhost'),
    getMappedPort: vi.fn(() => 65432),
    stop: vi.fn(async () => {}),
  }
  const builder: any = {
    withEnvironment: vi.fn(() => builder),
    withExposedPorts: vi.fn(() => builder),
    withWaitStrategy: vi.fn(() => builder),
    start: vi.fn(async () => container),
  }
  const GenericContainer = vi.fn(() => builder)
  const Wait = { forListeningPorts: vi.fn(() => ({ __wait: true })) }
  return { container, builder, GenericContainer, Wait }
})

const pgHoisted = vi.hoisted(() => {
  const managedClient = { query: vi.fn().mockResolvedValue({ rows: [{ one: 1 }] }), release: vi.fn() }
  const managedPool = {
    connect: vi.fn().mockResolvedValue(managedClient),
    end: vi.fn(async () => {}),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }

  const externalAdminPool = {
    connect: vi.fn(),
    end: vi.fn(async () => {}),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }

  const externalDestroyAdminPool = {
    connect: vi.fn(),
    end: vi.fn(async () => {}),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }

  // Reusable-db specific pool for readiness
  const reusableClient = { query: vi.fn().mockResolvedValue({ rows: [{ one: 1 }] }), release: vi.fn() }
  const reusablePool = { connect: vi.fn().mockResolvedValue(reusableClient), end: vi.fn() }

  const PoolCtor = vi
    .fn()
    // createDatabase managed waitForSelect1
    .mockImplementationOnce(() => managedPool)
    // createDatabase external: CREATE DATABASE
    .mockImplementationOnce(() => externalAdminPool)
    // createDatabase external: waitForSelect1 on new db
    .mockImplementationOnce(() => managedPool)
    // destroyDatabase external: terminate + drop
    .mockImplementationOnce(() => externalDestroyAdminPool)
    // createReusableDatabase readiness
    .mockImplementation(() => reusablePool)

  return {
    managedClient,
    managedPool,
    externalAdminPool,
    externalDestroyAdminPool,
    reusableClient,
    reusablePool,
    PoolCtor,
  }
})

// ---- Mocks ----
vi.mock('dockerode', () => {
  const ctor = vi.fn(() => dockerHoisted.dockerInstance)
  return { default: ctor }
})

import getPort from 'get-port'
vi.mock('get-port', () => ({ default: vi.fn(async ({ port }: any) => port) }))

vi.mock('testcontainers', () => ({
  GenericContainer: tcHoisted.GenericContainer,
  Wait: tcHoisted.Wait,
}))

vi.mock('pg', () => ({ Pool: pgHoisted.PoolCtor }))

// Stable randomBytes so generated db/user/password are predictable
vi.mock('crypto', () => ({
  randomBytes: vi.fn((n: number) => Buffer.from('a'.repeat(n * 2).slice(0, n * 2), 'hex')),
}))

// Mock embeddings to avoid downloading models (createReusableDatabase pulls these)
vi.mock('../src/utils/embeddings', () => ({
  createLocalEmbeddingProvider: vi.fn(async () => ({
    name: 'mock-emb',
    dimension: 384,
    embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
    embedBatch: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  })),
}))

// Silence logger output in this test file
vi.mock('../src/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

const openDbHoisted = vi.hoisted(() => {
  const client = { close: vi.fn(async () => {}) }
  const openDatabase = vi.fn(async () => client)
  return { client, openDatabase }
})

vi.mock('../src/index.js', () => ({
  openDatabase: openDbHoisted.openDatabase,
}))

// Import after mocks
import { createDatabase, createReusableDatabase, destroyDatabase } from '../src/runtime'

function makeInspect(hostPort: number, running = true) {
  return async () => ({
    State: { Running: running },
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: String(hostPort) }] },
    },
  })
}

describe('runtime.ts public API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createDatabase() managed mode: starts a container, waits for readiness, returns managed handle and destroy() stops container', async () => {
    const handle = await createDatabase()

    expect(tcHoisted.GenericContainer).toHaveBeenCalledWith('pgvector/pgvector:pg16')
    expect(tcHoisted.builder.withEnvironment).toHaveBeenCalled()
    expect(tcHoisted.builder.withExposedPorts).toHaveBeenCalledWith(5432)
    expect(tcHoisted.builder.withWaitStrategy).toHaveBeenCalled()
    expect(tcHoisted.builder.start).toHaveBeenCalled()

    // connection string derived from container host+mapped port
    expect(handle.connectionString).toBe(
      'postgresql://u_aaaaaaaa:aaaaaaaaaaaaaaaaaaaaaaaa@localhost:65432/tfdb_aaaaaaaaaaaa',
    )
    expect(handle.isManaged).toBe(true)
    expect(handle.dbName).toBe('tfdb_aaaaaaaaaaaa')

    // readiness
    expect(pgHoisted.managedPool.connect).toHaveBeenCalled()
    expect(pgHoisted.managedClient.query).toHaveBeenCalledWith('SELECT 1')

    // openDatabase called for schema init/usage
    expect(openDbHoisted.openDatabase).toHaveBeenCalledWith({
      connectionString: handle.connectionString,
      logLevel: undefined,
    })

    // destroy should stop container and close client
    await handle.destroy()
    expect(openDbHoisted.client.close).toHaveBeenCalled()
    expect(tcHoisted.container.stop).toHaveBeenCalled()

    // idempotent destroy
    await handle.destroy()
    expect(tcHoisted.container.stop).toHaveBeenCalledTimes(1)
  })

  it('createDatabase() external mode: creates temp DB on provided server, waits for readiness, and destroy drops the db', async () => {
    const baseConn = 'postgresql://user:pass@localhost:5432/postgres'

    const handle = await createDatabase({ connectionString: baseConn, logLevel: 'error' })

    expect(handle.isManaged).toBe(false)
    expect(handle.dbName).toBe('tfdb_aaaaaaaaaaaa')
    expect(handle.connectionString).toBe(
      'postgresql://user:pass@localhost:5432/tfdb_aaaaaaaaaaaa',
    )

    // admin CREATE DATABASE executed
    expect(pgHoisted.externalAdminPool.query).toHaveBeenCalledWith('CREATE DATABASE "tfdb_aaaaaaaaaaaa"')

    // readiness on new DB
    expect(pgHoisted.managedClient.query).toHaveBeenCalledWith('SELECT 1')

    // openDatabase called against new db
    expect(openDbHoisted.openDatabase).toHaveBeenCalledWith({
      connectionString: 'postgresql://user:pass@localhost:5432/tfdb_aaaaaaaaaaaa',
      logLevel: 'error',
    })

    // destroyDatabase calls safeDestroy which should terminate connections and drop db
    await destroyDatabase(handle)

    expect(openDbHoisted.client.close).toHaveBeenCalled()
    expect(pgHoisted.externalDestroyAdminPool.query).toHaveBeenCalledWith(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      ['tfdb_aaaaaaaaaaaa'],
    )
    expect(pgHoisted.externalDestroyAdminPool.query).toHaveBeenCalledWith(
      'DROP DATABASE IF EXISTS "tfdb_aaaaaaaaaaaa"',
    )

    // idempotent
    await destroyDatabase(handle)
    expect(pgHoisted.externalDestroyAdminPool.query).toHaveBeenCalledTimes(2)
  })

  it('createReusableDatabase(): creates container on first call and returns created=true', async () => {
    const start = vi.fn(async () => {})
    const inspect = makeInspect(5435, true)
    const container = { start, inspect }

    dockerHoisted.dockerInstance = {
      listContainers: vi.fn(async () => []),
      listImages: vi.fn(async () => [{ Id: 'img' }]),
      createContainer: vi.fn(async () => container),
      getContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn((_: any, cb: any) => cb()) },
    }

    const res = await createReusableDatabase()

    expect(dockerHoisted.dockerInstance.listContainers).toHaveBeenCalled()
    expect(dockerHoisted.dockerInstance.createContainer).toHaveBeenCalled()
    expect(start).toHaveBeenCalled()
    expect(res.created).toBe(true)
    expect(res.connectionString).toBe('postgresql://thefactory:thefactory@localhost:5435/thefactorydb')

    // readiness
    expect(pgHoisted.reusablePool.connect).toHaveBeenCalled()
    expect(pgHoisted.reusableClient.query).toHaveBeenCalledWith('SELECT 1')
  })

  it('createReusableDatabase(): returns existing running container mapping without creating (created=false)', async () => {
    const existing = { Id: 'abc', Names: ['/thefactory-db'] }
    const inspect = makeInspect(5435, true)
    const getContainer = vi.fn(() => ({ inspect }))

    dockerHoisted.dockerInstance = {
      listContainers: vi.fn(async () => [existing]),
      getContainer,
      listImages: vi.fn(),
      createContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn() },
    }

    const res = await createReusableDatabase()

    expect(dockerHoisted.dockerInstance.listContainers).toHaveBeenCalled()
    expect(getContainer).toHaveBeenCalledWith('abc')
    expect(dockerHoisted.dockerInstance.createContainer).not.toHaveBeenCalled()
    expect(res.created).toBe(false)
    expect(res.connectionString).toBe('postgresql://thefactory:thefactory@localhost:5435/thefactorydb')
  })

  it('createReusableDatabase(): starts an existing stopped container and returns same mapping (created=false)', async () => {
    const existing = { Id: 'abc', Names: ['/thefactory-db'] }
    const start = vi.fn(async () => {})
    const inspect = makeInspect(5435, false)
    const getContainer = vi.fn(() => ({ inspect, start }))

    dockerHoisted.dockerInstance = {
      listContainers: vi.fn(async () => [existing]),
      getContainer,
      listImages: vi.fn(),
      createContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn() },
    }

    const res = await createReusableDatabase()

    expect(getContainer).toHaveBeenCalledWith('abc')
    expect(start).toHaveBeenCalled()
    expect(res.created).toBe(false)
    expect(res.connectionString).toBe('postgresql://thefactory:thefactory@localhost:5435/thefactorydb')

    // readiness
    expect(pgHoisted.reusableClient.query).toHaveBeenCalledWith('SELECT 1')
  })

  it('createReusableDatabase(): falls back to a different port when 5435 is occupied', async () => {
    vi.mocked(getPort).mockResolvedValueOnce(55555 as any)

    const start = vi.fn(async () => {})
    const inspect = makeInspect(55555, true)
    const container = { start, inspect }

    dockerHoisted.dockerInstance = {
      listContainers: vi.fn(async () => []),
      listImages: vi.fn(async () => [{ Id: 'img' }]),
      createContainer: vi.fn(async () => container),
      getContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn((_: any, cb: any) => cb()) },
    }

    const res = await createReusableDatabase()

    expect(dockerHoisted.dockerInstance.createContainer).toHaveBeenCalled()
    expect(res.connectionString).toBe('postgresql://thefactory:thefactory@localhost:55555/thefactorydb')
    expect(res.created).toBe(true)
  })
})
