import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => {
  const state = { loaded: 0 }
  const container = {
    getHost: () => 'localhost',
    getMappedPort: () => 65432,
    stop: async () => {},
  }
  const builder: Record<string, unknown> = {}
  Object.assign(builder, {
    withEnvironment: () => builder,
    withExposedPorts: () => builder,
    withWaitStrategy: () => builder,
    withName: () => builder,
    start: async () => container,
  })
  const pool = {
    connect: async () => ({ query: async () => ({ rows: [] }), release: () => {} }),
    query: async () => ({ rows: [] }),
    end: async () => {},
  }
  return { state, builder, pool }
})

vi.mock('pg', () => ({ Pool: vi.fn(() => hoisted.pool) }))

vi.mock('../src/index.js', () => ({
  openDatabase: vi.fn(async () => ({ close: async () => {} })),
}))

beforeEach(() => {
  vi.resetModules()
  hoisted.state.loaded = 0
  vi.doMock('testcontainers', () => {
    hoisted.state.loaded += 1
    return {
      GenericContainer: vi.fn(() => hoisted.builder),
      Wait: { forListeningPorts: vi.fn(() => ({})) },
    }
  })
})

describe('runtime loads testcontainers only for an ephemeral managed database', () => {
  it('importing the runtime does not load testcontainers', async () => {
    await import('../src/runtime')
    expect(hoisted.state.loaded).toBe(0)
  })

  it('an external-mode database never loads it', async () => {
    const { createDatabase } = await import('../src/runtime')
    await createDatabase({ connectionString: 'postgresql://u:p@localhost:5432/db' })
    expect(hoisted.state.loaded).toBe(0)
  })

  it('a managed database loads it when it is created', async () => {
    const { createDatabase } = await import('../src/runtime')
    const handle = await createDatabase()
    expect(hoisted.state.loaded).toBe(1)
    expect(handle.isManaged).toBe(true)
  })
})
