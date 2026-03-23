import type { Pool, PoolClient } from 'pg'

export type MigrationContext = {
  /** pg Pool for running queries; migrations should prefer ctx.client inside transactions. */
  db: Pool
  /** A dedicated client (typically inside a transaction) */
  client: PoolClient
}

export type Migration = {
  version: number
  id: string
  up: (ctx: MigrationContext) => Promise<void>
}
