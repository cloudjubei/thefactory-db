import { describe, it, expect } from 'vitest'
import { createReusableDatabase, openDatabase } from '../../src/index'
import Docker from 'dockerode'

async function isDockerAvailable(): Promise<boolean> {
  const docker = new Docker()
  try {
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

maybeDescribe('Lifecycle smoke: Reusable persistent local instance', () => {
  it('provisions a persistent container and is idempotent', async () => {
    const r1 = await createReusableDatabase({ logLevel: 'error' })
    expect(r1.connectionString).toMatch(/^postgresql:\/\/thefactory:thefactory@localhost:\d+\/thefactorydb$/)

    // created may be false if container pre-exists in CI/local env
    expect([true, false]).toContain(r1.created)

    // Schema should exist: try to open and perform a quick op
    const db = await openDatabase({ connectionString: r1.connectionString, logLevel: 'error' })
    // simple smoke op: add and fetch a document
    const projectId = `reusable-smoke-${Date.now()}`
    const d = await db.addDocument({ projectId, type: 'note', src: 'c.txt', name: 'C', content: 'hello reusable' })
    expect(d.projectId).toBe(projectId)
    await db.close()

    const r2 = await createReusableDatabase({ logLevel: 'error' })
    expect(r2.connectionString).toEqual(r1.connectionString)
    expect(r2.created).toBe(false)
  }, 180_000)

  // Note: do not destroy the reusable container here; it is intended for reuse across runs.
})
