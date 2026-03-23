import { vi, beforeEach } from 'vitest'
import { openPostgres } from '../../src/connection'
import { createLogger } from '../../src/logger'
import { createLocalEmbeddingProvider } from '../../src/utils/embeddings'
import { stringifyJsonValues } from '../../src/utils/json'

// IMPORTANT:
// These mocks must be registered before importing the SUT (e.g. '../../src/index').
// So test files should import from this module before importing openDatabase.

// Keep SQL stable in tests
vi.mock('../../src/sql', () => ({
  SQL: new Proxy({}, { get: () => 'FAKE_SQL' }),
}))

vi.mock('../../src/connection')
vi.mock('../../src/logger')
vi.mock('../../src/utils/embeddings')
vi.mock('../../src/utils/json')

export type UnitTestMocks = {
  mockDbClient: any
  mockLogger: any
  mockEmbeddingProvider: any
}

/**
 * Attaches a minimal `connect()` implementation to a mock DB client so that
 * `migrateDatabase` can acquire an advisory lock and read the current schema_version
 * without failing or trying to hit a real DB.
 */
export function attachMigrationSupport(mockDb: any, options: { schemaVersion?: number } = {}) {
  const version = options.schemaVersion ?? 0

  const lockClient = {
    query: vi.fn(async (sql: string) => {
      const s = (sql || '').toLowerCase()
      if (s.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }], rowCount: 1 }
      if (s.includes('select schema_version')) return { rows: [{ schema_version: version }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }

  mockDb.connect = vi.fn().mockResolvedValue(lockClient)
  return mockDb
}

/**
 * Shared unit-test setup for db unit tests.
 * Call once at top-level of each test file.
 */
export function setupUnitTestMocks(): UnitTestMocks {
  // IMPORTANT:
  // Keep object identity stable across the test file.
  // The SUT will capture references (db client, logger, provider) during openDatabase().

  const mockDbClient: any = {
    query: vi.fn(),
    end: vi.fn(),
  }
  
  attachMigrationSupport(mockDbClient)

  const mockLogger: any = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }

  const mockEmbeddingProvider: any = {
    embed: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
    close: vi.fn(),
  }

  // Wire module mocks to our stable objects
  vi.mocked(openPostgres).mockResolvedValue(mockDbClient)
  vi.mocked(createLogger).mockReturnValue(mockLogger)
  vi.mocked(createLocalEmbeddingProvider).mockResolvedValue(mockEmbeddingProvider)
  vi.mocked(stringifyJsonValues).mockImplementation((val) => JSON.stringify(val))

  beforeEach(() => {
    vi.clearAllMocks()

    // Re-wire after clearAllMocks to ensure implementations remain
    vi.mocked(openPostgres).mockResolvedValue(mockDbClient)
    vi.mocked(createLogger).mockReturnValue(mockLogger)
    vi.mocked(createLocalEmbeddingProvider).mockResolvedValue(mockEmbeddingProvider)
    vi.mocked(stringifyJsonValues).mockImplementation((val) => JSON.stringify(val))

    // Restore default embedding return value
    mockEmbeddingProvider.embed.mockResolvedValue([0.1, 0.2, 0.3])
    
    // Restore lock client mock
    attachMigrationSupport(mockDbClient)
  })

  return { mockDbClient, mockLogger, mockEmbeddingProvider }
}
