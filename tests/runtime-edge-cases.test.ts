import { beforeEach, describe, expect, it, vi } from 'vitest'

// These tests exercise error/retry branches of runtime.ts. They use a per-test
// `factory.next` queue so each `new Pool(...)` call can be wired independently —
// avoiding the order-coupled mockImplementationOnce chain in tests/runtime.test.ts.

const dockerHoisted = vi.hoisted(() => ({ dockerInstance: {} as Record<string, any> }))

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
    withName: vi.fn(() => builder),
    start: vi.fn(async () => container),
  }
  const GenericContainer = vi.fn(() => builder)
  const Wait = { forListeningPorts: vi.fn(() => ({ __wait: true })) }
  return { container, builder, GenericContainer, Wait }
})

type PoolStub = {
  connect: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  query?: ReturnType<typeof vi.fn>
}

const pgHoisted = vi.hoisted(() => {
  const factory: { next: Array<() => unknown> } = { next: [] }
  const PoolCtor = vi.fn(() => {
    const impl = factory.next.shift()
    if (impl) return impl()
    return {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [{ one: 1 }] }),
        release: vi.fn(),
      }),
      end: vi.fn(),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    }
  })
  return { factory, PoolCtor }
})

vi.mock('dockerode', () => ({ default: vi.fn(() => dockerHoisted.dockerInstance) }))
vi.mock('get-port', () => ({ default: vi.fn(async ({ port }: { port: number }) => port) }))
vi.mock('testcontainers', () => ({
  GenericContainer: tcHoisted.GenericContainer,
  Wait: tcHoisted.Wait,
}))
vi.mock('pg', () => ({ Pool: pgHoisted.PoolCtor }))
vi.mock('crypto', () => ({
  randomBytes: vi.fn((n: number) => Buffer.from('a'.repeat(n * 2).slice(0, n * 2), 'hex')),
}))
vi.mock('../src/utils/embeddings', () => ({
  createLocalEmbeddingProvider: vi.fn(async () => ({
    name: 'mock-emb',
    dimension: 384,
    embed: vi.fn(async () => new Float32Array([0.1, 0.2, 0.3])),
    embedBatch: vi.fn(async () => []),
    close: vi.fn(async () => {}),
  })),
}))
vi.mock('../src/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

const openDbHoisted = vi.hoisted(() => {
  const client = { close: vi.fn(async () => {}) }
  const openDatabase = vi.fn(async () => client)
  return { client, openDatabase }
})
vi.mock('../src/index.js', () => ({ openDatabase: openDbHoisted.openDatabase }))

import { createDatabase, createReusableDatabase, destroyDatabase } from '../src/runtime'

function okPool(): PoolStub {
  return {
    connect: vi.fn().mockResolvedValue({
      query: vi.fn().mockResolvedValue({ rows: [{ one: 1 }] }),
      release: vi.fn(),
    }),
    end: vi.fn(),
    query: vi.fn().mockResolvedValue({ rows: [] }),
  }
}

function failingPool(message: string): PoolStub {
  const err = new Error(message)
  return {
    connect: vi.fn().mockRejectedValue(err),
    end: vi.fn(),
    query: vi.fn().mockRejectedValue(err),
  }
}

function runningInspect(hostPort: number | undefined) {
  return vi.fn(async () => ({
    State: { Running: true },
    NetworkSettings: {
      Ports: {
        '5432/tcp':
          hostPort === undefined ? [] : [{ HostIp: '0.0.0.0', HostPort: String(hostPort) }],
      },
    },
  }))
}

function setDocker(overrides: Record<string, unknown>) {
  dockerHoisted.dockerInstance = {
    listContainers: vi.fn(async () => []),
    listImages: vi.fn(async () => [{ Id: 'img' }]),
    createContainer: vi.fn(),
    getContainer: vi.fn(),
    pull: vi.fn(),
    modem: { followProgress: vi.fn() },
    ...overrides,
  }
}

describe('runtime edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    pgHoisted.factory.next = []
    // clearAllMocks resets the chained implementations on the testcontainers/pg mocks;
    // restore the fluent builder + container/openDatabase defaults each test.
    tcHoisted.builder.start.mockImplementation(async () => tcHoisted.container)
    tcHoisted.builder.withEnvironment.mockImplementation(() => tcHoisted.builder)
    tcHoisted.builder.withExposedPorts.mockImplementation(() => tcHoisted.builder)
    tcHoisted.builder.withWaitStrategy.mockImplementation(() => tcHoisted.builder)
    tcHoisted.builder.withName.mockImplementation(() => tcHoisted.builder)
    tcHoisted.container.stop.mockImplementation(async () => {})
    openDbHoisted.openDatabase.mockImplementation(async () => openDbHoisted.client)
    openDbHoisted.client.close.mockImplementation(async () => {})
  })

  it('waitForSelect1 retries connect failures until one succeeds', async () => {
    const failing = failingPool('not ready yet')
    const good = okPool()
    pgHoisted.factory.next.push(
      () => failing,
      () => good,
    )

    const handle = await createDatabase()

    expect(handle.isManaged).toBe(true)
    expect(failing.connect).toHaveBeenCalled()
    // pool.end() must always run even when connect rejected, so sockets don't leak.
    expect(failing.end).toHaveBeenCalled()
    expect(good.connect).toHaveBeenCalled()
  }, 10000)

  it('safeDestroy swallows client.close errors and still stops the container', async () => {
    pgHoisted.factory.next.push(okPool)

    const handle = await createDatabase()
    openDbHoisted.client.close.mockRejectedValueOnce(new Error('close blew up'))

    await expect(handle.destroy()).resolves.toBeUndefined()
    expect(tcHoisted.container.stop).toHaveBeenCalled()
  })

  it('safeDestroy swallows admin pool errors when dropping an external db', async () => {
    // Three Pool() calls during external createDatabase + one during destroy.
    pgHoisted.factory.next.push(okPool, okPool, () => failingPool('admin dead'))

    const handle = await createDatabase({
      connectionString: 'postgresql://user:pass@localhost:5432/postgres',
    })

    await expect(destroyDatabase(handle)).resolves.toBeUndefined()
  })

  it('safeDestroy swallows container.stop errors and still removes the handle from the cleanup set', async () => {
    pgHoisted.factory.next.push(okPool)
    tcHoisted.container.stop.mockRejectedValueOnce(new Error('container stuck'))

    const handle = await createDatabase()
    await expect(handle.destroy()).resolves.toBeUndefined()
    expect(tcHoisted.container.stop).toHaveBeenCalled()
    // Second destroy must still be a no-op despite the prior stop error.
    await expect(handle.destroy()).resolves.toBeUndefined()
    expect(tcHoisted.container.stop).toHaveBeenCalledTimes(1)
  })

  it('waitForSelect1 swallows pool.end errors after a successful connect', async () => {
    const flakyEnd = okPool()
    flakyEnd.end.mockRejectedValueOnce(new Error('pool.end blew up'))
    pgHoisted.factory.next.push(() => flakyEnd)

    const handle = await createDatabase()
    expect(handle.isManaged).toBe(true)
    expect(flakyEnd.end).toHaveBeenCalled()
  })

  it('createReusableDatabase forwards logLevel to the schema-init openDatabase call', async () => {
    const start = vi.fn(async () => {})
    const container = { start, inspect: runningInspect(5435) }
    setDocker({
      listImages: vi.fn(async () => [{ Id: 'img' }]),
      createContainer: vi.fn(async () => container),
    })

    await createReusableDatabase({ logLevel: 'debug' })

    expect(openDbHoisted.openDatabase).toHaveBeenCalledWith({
      connectionString: 'postgresql://thefactory:thefactory@localhost:5435/thefactorydb',
      logLevel: 'debug',
    })
  })

  it('createReusableDatabase pulls the image when listImages is empty', async () => {
    const start = vi.fn(async () => {})
    const container = { start, inspect: runningInspect(5435) }
    const pull = vi.fn((_image: string, cb: (err: unknown, stream: unknown) => void) => {
      const stream: any = {
        on: vi.fn((evt: string, fn: () => void) => {
          if (evt === 'end') setImmediate(fn)
          return stream
        }),
        resume: vi.fn(),
      }
      cb(null, stream)
    })

    setDocker({
      listImages: vi.fn(async () => []),
      createContainer: vi.fn(async () => container),
      pull,
    })

    const res = await createReusableDatabase()

    expect(pull).toHaveBeenCalledWith('pgvector/pgvector:pg16', expect.any(Function))
    expect(res.created).toBe(true)
  })

  it('createReusableDatabase rejects when the image pull errors', async () => {
    const pull = vi.fn((_image: string, cb: (err: unknown) => void) => {
      cb(new Error('docker hub down'))
    })

    setDocker({ listImages: vi.fn(async () => []), pull })

    await expect(createReusableDatabase()).rejects.toThrow('docker hub down')
  })

  it('createReusableDatabase tolerates a stream that throws on handler registration', async () => {
    const start = vi.fn(async () => {})
    const container = { start, inspect: runningInspect(5435) }
    const pull = vi.fn((_image: string, cb: (err: unknown, stream: unknown) => void) => {
      const stream: any = {
        get on() {
          throw new Error('pump not yet ready')
        },
      }
      cb(null, stream)
    })

    setDocker({
      listImages: vi.fn(async () => []),
      createContainer: vi.fn(async () => container),
      pull,
    })

    const res = await createReusableDatabase()
    expect(res.created).toBe(true)
  })

  it('createReusableDatabase throws when an existing container reports an empty port mapping', async () => {
    setDocker({
      listContainers: vi.fn(async () => [{ Id: 'abc', Names: ['/thefactory-db'] }]),
      getContainer: vi.fn(() => ({ inspect: runningInspect(undefined) })),
    })

    await expect(createReusableDatabase()).rejects.toThrow(/Unable to determine mapped host port/i)
  })

  it('createReusableDatabase throws when an existing container has no Ports entry', async () => {
    const inspect = vi.fn(async () => ({
      State: { Running: true },
      NetworkSettings: { Ports: {} },
    }))
    setDocker({
      listContainers: vi.fn(async () => [{ Id: 'abc', Names: ['/thefactory-db'] }]),
      getContainer: vi.fn(() => ({ inspect })),
    })

    await expect(createReusableDatabase()).rejects.toThrow(/Unable to determine mapped host port/i)
  })
})
