// Public API barrel file.
// Keep this file small: implementation lives in ./client and other modules.

export { openDatabase } from './client/openDatabase.js'
export type { TheFactoryDb } from './client/types.js'

// Runtime lifecycle helpers (managed/external ephemeral DB)
export { createDatabase, destroyDatabase, createReusableDatabase } from './runtime.js'
export type { CreateDatabaseOptions, CreateReusableDatabaseOptions } from './runtime.js'

// Migration APIs
export { migrateDatabase, getDatabaseInfo } from './migrations/runner.js'
export type { MigrateOptions, DatabaseInfo } from './migrations/runner.js'

// Public types
export type * from './types.js'
