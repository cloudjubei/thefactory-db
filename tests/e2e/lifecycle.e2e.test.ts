import { describe, it, expect } from 'vitest'
import { createDatabase, destroyDatabase, createReusableDatabase, openDatabase } from '../../src/index'
import { Pool } from 'pg'
import Docker from 'dockerode'
import net from 'node:net'

const RUN = process.env.RUN_E2E === '1'
const DATABASE_URL = process.env.DATABASE_URL || ''

async function removeContainerIfExists(name: string): Promise<void> {
  const docker = new Docker()
  const list = await docker.listContainers({ all: true, filters: { name: [name] } as any })
  const found = list.find((c) => c.Names?.some((n) => n === `/${name}`))
  if (found) {
    const container = docker.getContainer(found.Id)
    try {
      const inspect = await container.inspect()
      if (inspect.State?.Running) await container.stop({ t: 5 })
    } catch {}
    try {
      await container.remove({ force: true })
    } catch {}
  }
}

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
    expect(first.connectionString).toMatch(/^postgresql:\/\/thefactory:thefactory@localhost:\d+\/thefactorydb$/)

    // Can connect and run schema
    const db = await openDatabase({ connectionString: first.connectionString, logLevel: 'warn' })
    await db.close()

    const second = await createReusableDatabase({ logLevel: 'warn' })
    expect(second.connectionString).toBe(first.connectionString)
    expect(second.created).toBe(false)
  }, 180_000)

  it('falls back to a different port if 5435 is occupied on first creation and persists mapping', async () => {
    // Ensure a clean slate to test initial creation behavior
    await removeContainerIfExists('thefactory-db')

    // Attempt to occupy 5435 before the first creation
    const blocker = net.createServer()
    let blocked = false
    await new Promise<void>((resolve) => {
      blocker.once('error', () => resolve())
      blocker.listen(5435, '127.0.0.1', () => {
        blocked = true
        resolve()
      })
    })

    try {
      const created = await createReusableDatabase({ logLevel: 'warn' })
      expect(created.created).toBe(true)
      expect(created.connectionString).toMatch(/^postgresql:\/\/thefactory:thefactory@localhost:\d+\/thefactorydb$/)

      const m = created.connectionString.match(/localhost:(\d+)\//)
      const port = Number(m?.[1] || '0')
      if (blocked) {
        expect(port).not.toBe(5435)
      }

      const again = await createReusableDatabase({ logLevel: 'warn' })
      expect(again.created).toBe(false)
      expect(again.connectionString).toBe(created.connectionString)
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()))
    }
  }, 240_000)
})
