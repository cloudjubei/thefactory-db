import { openPostgres } from '../connection.js'
import { createLogger } from '../logger.js'
import type { OpenDbOptions } from '../types.js'
import { createLocalEmbeddingProvider } from '../utils/embeddings.js'
import { createEntityApi } from './entities.js'
import { createDocumentApi } from './documents.js'
import type { TheFactoryDb } from './types.js'
import { migrateDatabase } from '../migrations/runner.js'

export async function openDatabase(options: OpenDbOptions): Promise<TheFactoryDb> {
  const { connectionString, logLevel, migrations } = options
  const logger = createLogger(logLevel)

  const db = await openPostgres(connectionString)

  // 1. Run migrations if auto (default)
  const isAuto = migrations === undefined || migrations === 'auto' || (typeof migrations === 'object' && migrations !== null)
  if (isAuto) {
    const toVersion = typeof migrations === 'object' ? migrations.toVersion : undefined
    logger.debug('Running database migrations (auto)...')
    await migrateDatabase(db, { toVersion, logLevel })
  }

  const embeddingProvider = await createLocalEmbeddingProvider()

  const entityApi = createEntityApi({ db, logger, embeddingProvider })
  const documentApi = createDocumentApi({ db, logger, embeddingProvider })

  async function close(): Promise<void> {
    logger.info('close')
    try {
      await embeddingProvider.close?.()
    } catch {
      // ignore embedding provider close errors
    } finally {
      await db.end()
    }
  }

  return {
    ...entityApi,
    ...documentApi,
    close,
    raw: () => db,
  }
}
