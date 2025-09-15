import { readSql } from './utils.js'
import { Client } from 'pg'

export type DB = Client

async function initSchema(client: DB) {
  const schemaSql = readSql('schema')
  const hybridSql = readSql('hybrid_search')

  if (schemaSql) {
    await client.query(schemaSql)
  }
  if (hybridSql) {
    await client.query(hybridSql)
  }
}

export async function openPostgres(connectionString: string): Promise<DB> {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    await initSchema(client)
  } catch (e) {
    await client.end() // close connection if init fails
    throw e
  }
  return client
}
