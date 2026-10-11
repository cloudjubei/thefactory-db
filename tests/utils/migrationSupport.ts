import { vi } from 'vitest'

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
      if (s.includes('select schema_version'))
        return { rows: [{ schema_version: version }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }),
    release: vi.fn(),
  }

  mockDb.connect = vi.fn().mockResolvedValue(lockClient)
  return mockDb
}
