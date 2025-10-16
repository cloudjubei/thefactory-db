import { describe, it, expect } from 'vitest'
import { createDatabase, destroyDatabase, createReusableDatabase, openDatabase } from '../../src/index'
import { Pool } from 'pg'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

;(RUN ? describe : describe.skip)('Lifecycle: Managed ephemeral container', () => {
  it('creates a fresh DB, can be used, and tears down idempotently', async () => {
    const { client, connectionString, destroy, isManaged, dbName } = await createDatabase({ logLevel: 'warn' })
    expect(isManaged).toBe(true)
    expect(typeof connectionString).toBe('string')
    expect(dbName).toMatch(/^db_|^tfdb_/)

    // Use the client
    const projectId = `lifecycle-managed-${Date.now()}`
    const d = await client.addDocument({ projectId, type: 'note', src: 'a.txt', name: 'a', content: 'hello world' })
    expect(d.projectId).toBe(projectId)

    // Destroy twice to ensure idempotency
    await destroy()
    await destroy()

    // After destroy, connection should fail
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

;(RUN && DATABASE_URL ? describe : describe.skip)('Lifecycle: External temporary database on provided server', () => {
  it('creates, initializes schema, and drops a temporary DB', async () => {
    const handle = await createDatabase({ connectionString: DATABASE_URL, logLevel: 'warn' })
    expect(handle.isManaged).toBe(false)

    const projectId = `lifecycle-external-${Date.now()}`
    const d = await handle.client.addDocument({ projectId, type: 'note', src: 'b.txt', name: 'b', content: 'hello ext' })
    expect(d.projectId).toBe(projectId)

    const tmpDbName = handle.dbName

    await destroyDatabase(handle.handle)

    // Verify database is dropped by checking pg_database from admin db
    const adminUrl = new URL(DATABASE_URL)
    adminUrl.pathname = '/postgres'
    const pool = new Pool({ connectionString: adminUrl.toString() })
    const r = await pool.query('SELECT 1 FROM pg_database WHERE datname = $1', [tmpDbName])
    await pool.end().catch(() => {})
    expect(r.rowCount).toBe(0)
  }, 120_000)
})

;(RUN ? describe : describe.skip)('Reusable provisioning: persistent local instance', () => {
  it('provisions a persistent container and is idempotent', async () => {
    const first = await createReusableDatabase({ logLevel: 'warn' })
    expect(first.connectionString).toContain('postgresql://')

    // Can connect and run schema
    const db = await openDatabase({ connectionString: first.connectionString, logLevel: 'warn' })
    await db.close()

    const second = await createReusableDatabase({ logLevel: 'warn' })
    expect(second.connectionString).toBe(first.connectionString)
    expect(second.created).toBe(false)
  }, 180_000)
})
