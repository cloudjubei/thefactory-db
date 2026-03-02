import { openPostgres } from '../connection.js'
import { createLogger } from '../logger.js'
import type { OpenDbOptions } from '../types.js'
import { createLocalEmbeddingProvider } from '../utils/embeddings.js'
import { createEntityApi } from './entities.js'
import { createDocumentApi } from './documents.js'
import type { TheFactoryDb } from './types.js'

export async function openDatabase({
  connectionString,
  logLevel,
}: OpenDbOptions): Promise<TheFactoryDb> {
  const logger = createLogger(logLevel)
  const db = await openPostgres(connectionString)
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
