import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted shared mocks state
const hoisted = vi.hoisted(() => ({
  dockerInstance: {} as any,
}))

// Mock dockerode constructor to return our per-test instance
vi.mock('dockerode', () => {
  const ctor = vi.fn(() => hoisted.dockerInstance)
  return { default: ctor }
})

// Mock get-port: by default returns the preferred port; tests can override
import getPort from 'get-port'
vi.mock('get-port', () => ({ default: vi.fn(async ({ port }: any) => port) }))

// Mock pg Pool used by waitForSelect1 and openPostgres/openDatabase
const pgHoisted = vi.hoisted(() => {
  const client = { query: vi.fn().mockResolvedValue({ rows: [{ one: 1 }] }), release: vi.fn() }
  const pool = { connect: vi.fn().mockResolvedValue(client), end: vi.fn() }
  const PoolCtor = vi.fn(() => pool)
  return { client, pool, PoolCtor }
})
vi.mock('pg', () => ({ Pool: pgHoisted.PoolCtor }))

// Mock embeddings to avoid downloading models
vi.mock('../src/utils/embeddings', () => ({
  createLocalEmbeddingProvider: vi.fn(async () => ({
    name: 'mock-emb',
    dimension: 384,
    embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
    embedBatch: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  })),
}))

// Import the function under test after mocks
import { createReusableDatabase } from '../src/runtime'

function makeInspect(hostPort: number, running = true) {
  return async () => ({
    State: { Running: running },
    NetworkSettings: {
      Ports: { '5432/tcp': [{ HostIp: '0.0.0.0', HostPort: String(hostPort) }] },
    },
  })
}

describe('createReusableDatabase (managed persistent container)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates container on first call and initializes schema (created=true)', async () => {
    const start = vi.fn(async () => {})
    const inspect = makeInspect(5435, true)
    const container = { start, inspect }

    hoisted.dockerInstance = {
      listContainers: vi.fn(async () => []),
      listImages: vi.fn(async () => [{ Id: 'img' }]),
      createContainer: vi.fn(async () => container),
      getContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn((_: any, cb: any) => cb()) },
    }

    const res = await createReusableDatabase()

    expect(hoisted.dockerInstance.listContainers).toHaveBeenCalled()
    expect(hoisted.dockerInstance.createContainer).toHaveBeenCalled()
    expect(start).toHaveBeenCalled()
    expect(res.created).toBe(true)
    expect(res.connectionString).toBe(
      'postgresql://thefactory:thefactory@localhost:5435/thefactorydb',
    )

    // waitForSelect1 should have attempted to connect
    expect(pgHoisted.PoolCtor).toHaveBeenCalled()
    expect(pgHoisted.pool.connect).toHaveBeenCalled()
    expect(pgHoisted.client.query).toHaveBeenCalledWith('SELECT 1')
  })

  it('returns existing running container mapping without creating (created=false)', async () => {
    const existing = { Id: 'abc', Names: ['/thefactory-db'] }
    const inspect = makeInspect(5435, true)
    const getContainer = vi.fn(() => ({ inspect }))

    hoisted.dockerInstance = {
      listContainers: vi.fn(async () => [existing]),
      getContainer,
      listImages: vi.fn(),
      createContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn() },
    }

    const res = await createReusableDatabase()

    expect(hoisted.dockerInstance.listContainers).toHaveBeenCalled()
    expect(getContainer).toHaveBeenCalledWith('abc')
    expect(hoisted.dockerInstance.createContainer).not.toHaveBeenCalled()
    expect(res.created).toBe(false)
    expect(res.connectionString).toBe(
      'postgresql://thefactory:thefactory@localhost:5435/thefactorydb',
    )
  })

  it('starts an existing stopped container and returns same mapping (created=false)', async () => {
    const existing = { Id: 'abc', Names: ['/thefactory-db'] }
    const start = vi.fn(async () => {})
    const inspect = makeInspect(5435, false) // not running
    const getContainer = vi.fn(() => ({ inspect, start }))

    hoisted.dockerInstance = {
      listContainers: vi.fn(async () => [existing]),
      getContainer,
      listImages: vi.fn(),
      createContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn() },
    }

    const res = await createReusableDatabase()

    expect(hoisted.dockerInstance.listContainers).toHaveBeenCalled()
    expect(getContainer).toHaveBeenCalledWith('abc')
    expect(start).toHaveBeenCalled()
    expect(res.created).toBe(false)
    expect(res.connectionString).toBe(
      'postgresql://thefactory:thefactory@localhost:5435/thefactorydb',
    )
    // readiness should be checked
    expect(pgHoisted.client.query).toHaveBeenCalledWith('SELECT 1')
  })

  it('falls back to a different port when 5435 is occupied and returns that port', async () => {
    // Force get-port to choose a different port
    vi.mocked(getPort).mockResolvedValueOnce(55555 as any)

    const start = vi.fn(async () => {})
    const inspect = makeInspect(55555, true)
    const container = { start, inspect }

    hoisted.dockerInstance = {
      listContainers: vi.fn(async () => []),
      listImages: vi.fn(async () => [{ Id: 'img' }]),
      createContainer: vi.fn(async () => container),
      getContainer: vi.fn(),
      pull: vi.fn(),
      modem: { followProgress: vi.fn((_: any, cb: any) => cb()) },
    }

    const res = await createReusableDatabase()

    expect(hoisted.dockerInstance.createContainer).toHaveBeenCalled()
    expect(res.connectionString).toBe(
      'postgresql://thefactory:thefactory@localhost:55555/thefactorydb',
    )
    expect(res.created).toBe(true)
  })
})
