import { describe, it, expect } from 'vitest'
import { createDatabase, destroyDatabase } from '../../src/index'
import { Pool } from 'pg'

const DATABASE_SERVER_URL = process.env.DATABASE_SERVER_URL || ''
const maybeDescribe = DATABASE_SERVER_URL ? describe : describe.skip

maybeDescribe('Lifecycle smoke: External server temporary database', () => {
  it('creates a temp DB, initializes schema, and drops it on destroy', async () => {
    const handle = await createDatabase({ connectionString: DATABASE_SERVER_URL, logLevel: 'error' })
    expect(handle.isManaged).toBe(false)

    const projectId = `external-smoke-${Date.now()}`

    const d = await handle.client.addDocument({ projectId, type: 'note', src: 'b.txt', name: 'B', content: 'hello ext' })
    expect(d.projectId).toBe(projectId)

    const e = await handle.client.addEntity({ projectId, type: 'kv', content: { x: 'y' } })
    expect(e.projectId).toBe(projectId)

    const tmpDbName = handle.dbName

    await destroyDatabase(handle.handle)

    // Verify database is dropped by checking pg_database from admin db (postgres)
    const adminUrl = new URL(DATABASE_SERVER_URL)
    adminUrl.pathname = '/postgres'
    const pool = new Pool({ connectionString: adminUrl.toString() })
    const r = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [tmpDbName])
    await pool.end().catch(() => {})
    expect(r.rowCount).toBe(0)
  }, 120_000)
})
