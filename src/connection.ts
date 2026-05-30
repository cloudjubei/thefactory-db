import { Pool, PoolClient } from 'pg'

/**
 * Represents the raw database client from the `pg` library.
 */
export type DB = Pool

/**
 * Default connect-timeout for the long-lived pool. pg's own default is
 * "wait forever" — fine in production where you'd notice immediately, but
 * during local development a stopped DB container silently hangs the entire
 * backend boot. 15 s is long enough to absorb a slow disk/migration startup,
 * short enough to surface a misconfiguration before the operator gives up.
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 15_000

/**
 * Opens a new PostgreSQL connection pool and verifies connectivity.
 * @param connectionString - The PostgreSQL connection string.
 * @returns A promise that resolves to the connected pool.
 * @throws Will throw an error if the connection fails (including timeout).
 */
export async function openPostgres(connectionString: string): Promise<DB> {
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
  })

  const client = await pool.connect()
  try {
    await verifyConnection(client)
  } catch (e) {
    await pool.end()
    throw e
  } finally {
    client.release()
  }

  return pool
}

/**
 * Verifies that a database client can reach the server by issuing a
 * lightweight no-op query. Used during pool initialisation to fail fast
 * on bad credentials or unreachable hosts before any real work begins.
 */
async function verifyConnection(client: PoolClient): Promise<void> {
  await client.query('SELECT 1')
}

export type ProbeResult = { ok: true } | { ok: false; error: string }

/**
 * Fresh, timeout-bounded health probe — opens a throwaway pool, runs
 * `SELECT 1`, closes the pool. Deliberately does NOT share state with any
 * long-lived pool from {@link openPostgres}: that long-lived pool may be
 * wedged on migrations or a slow first connect, and a health check has to
 * keep working precisely when the main path doesn't.
 *
 * Resolves within `timeoutMs` (default 5s) whether the underlying probe
 * succeeds, fails, or stalls. Never throws — failure modes come back as
 * `{ ok: false, error }` so consumers can render the message verbatim.
 */
export async function probeDatabase(
  connectionString: string,
  timeoutMs: number = 5000,
): Promise<ProbeResult> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: timeoutMs })

  let client: PoolClient | undefined
  const probe = (async (): Promise<ProbeResult> => {
    try {
      client = await pool.connect()
      await client.query('SELECT 1')
      return { ok: true }
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      client?.release()
    }
  })()

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `Database probe timed out after ${timeoutMs}ms` }),
      timeoutMs,
    )
  })

  try {
    return await Promise.race([probe, timeout])
  } finally {
    if (timer) clearTimeout(timer)
    // Close the throwaway pool unconditionally. Errors during teardown
    // can't change the probe outcome and must not leak.
    try {
      await pool.end()
    } catch {
      // ignore
    }
  }
}
