import { vi, beforeEach } from 'vitest'

import { openPostgres } from '../../src/connection'
import { createLogger } from '../../src/logger'
import { createLocalEmbeddingProvider } from '../../src/utils/embeddings'
import { stringifyJsonValues } from '../../src/utils/json'

import { attachMigrationSupport } from './migrationSupport'

// IMPORTANT:
// These mocks must be registered before importing the SUT (e.g. '../../src/index').
// So test files should import from this module before importing openDatabase.

// Keep SQL stable in tests. `entitySelectColumns` / `ENTITY_SELECT_COLUMNS` are real named exports
// consumed by the dynamic entity-query builder, so the mock must provide them too (a stand-in column
// list is enough — the builder's behaviour is asserted against the REAL sql module in entityQuery.test.ts).
// Keep the REAL module and override only `SQL`: the other named exports are load-bearing — migrations
// install the hybrid-search functions from `HYBRID_SEARCH_*_FUNCTION`, and `resolveCandidateLimit` is the
// clamp the clients apply, which tests assert on directly.
vi.mock('../../src/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/sql')>()
  const entitySelectColumns = (contentExpr = 'content') =>
    contentExpr === 'content'
      ? ' id, project_id AS "projectId", content '
      : ` id, project_id AS "projectId", ${contentExpr} AS content `
  return {
    ...actual,
    SQL: new Proxy({}, { get: () => 'FAKE_SQL' }),
    entitySelectColumns,
    ENTITY_SELECT_COLUMNS: entitySelectColumns(),
  }
})

vi.mock('../../src/connection')
vi.mock('../../src/logger')
vi.mock('../../src/utils/embeddings')
// Keep the REAL stripNullChars (so write-path null-byte stripping is exercised); only stub the
// value-flattening used for embeddings.
vi.mock('../../src/utils/json', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/json')>()
  return { ...actual, stringifyJsonValues: vi.fn() }
})

export type UnitTestMocks = {
  mockDbClient: any
  mockLogger: any
  mockEmbeddingProvider: any
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
    embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
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
    mockEmbeddingProvider.embedBatch.mockImplementation(async (texts: string[]) =>
      texts.map(() => [0.1, 0.2, 0.3]),
    )

    // Restore lock client mock
    attachMigrationSupport(mockDbClient)
  })

  return { mockDbClient, mockLogger, mockEmbeddingProvider }
}

export type TransactionResponder = (sql: string, params?: unknown[]) => { rows: unknown[] }

type CallsOf<Args extends unknown[]> = { mock: { calls: Args[] } }

/** Checks out a stand-in connection from the mocked pool; the batch transaction runs on it. */
export function useTransactionClient(
  mockDbClient: { connect: unknown },
  respond: TransactionResponder,
) {
  const tx = {
    query: vi.fn(async (sql: string, params?: unknown[]) => respond(sql, params)),
    release: vi.fn(),
  }
  mockDbClient.connect = vi.fn().mockResolvedValue(tx)
  return tx
}

/** The SQL of every statement a stand-in connection ran, in order. */
export function statements(tx: { query: CallsOf<[sql: string, ...rest: unknown[]]> }): string[] {
  return tx.query.mock.calls.map(([sql]) => sql)
}

/** Every text a document write embedded, one call per chunk. */
export function embeddedTexts(provider: { embed: CallsOf<[text: string]> }): string[] {
  return provider.embed.mock.calls.map(([text]) => text)
}
