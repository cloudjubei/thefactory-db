import { describe, it, expect } from 'vitest'
import { createDatabase } from '../../src/index'
import { Pool } from 'pg'
import Docker from 'dockerode'

async function isDockerAvailable(): Promise<boolean> {
  const docker = new Docker()
  try {
    // ping with a short timeout
    const pingPromise = docker.ping()
    const timeout = new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 1500))
    await Promise.race([pingPromise, timeout])
    return true
  } catch {
    return false
  }
}

const DOCKER = await isDockerAvailable()
const maybeDescribe = DOCKER ? describe : describe.skip

maybeDescribe('Lifecycle smoke: Managed ephemeral container', () => {
  it('creates a fresh DB, supports operations, and tears down fully', async () => {
    const { client, connectionString, destroy, isManaged, dbName } = await createDatabase({ logLevel: 'error' })
    expect(isManaged).toBe(true)
    expect(typeof connectionString).toBe('string')
    expect(dbName).toMatch(/^db_|^tfdb_/)

    const projectId = `managed-smoke-${Date.now()}`

    // Document ops
    const d = await client.addDocument({ projectId, type: 'note', src: 'a.txt', name: 'A', content: 'hello world' })
    expect(d.projectId).toBe(projectId)

    // Entity ops
    const e = await client.addEntity({ projectId, type: 'kv', content: { a: 1, b: 'two' } })
    expect(e.projectId).toBe(projectId)

    // Search smoke
    const docs = await client.searchDocuments({ query: 'hello', projectIds: [projectId], limit: 5 })
    expect(Array.isArray(docs)).toBe(true)

    const ents = await client.searchEntities({ query: 'two', projectIds: [projectId], limit: 5 })
    expect(Array.isArray(ents)).toBe(true)

    // Destroy twice to ensure idempotency
    await destroy()
    await destroy()

    // After destroy, a plain Pool should fail to query -> container gone and pool closed
    const pool = new Pool({ connectionString })
    let failed = false
    try {
      await pool.query('SELECT 1')
    } catch {
      failed = true
    } finally {
      await pool.end().catch(() => {})
    }
    expect(failed).toBe(true)
  }, 120_000)
})
