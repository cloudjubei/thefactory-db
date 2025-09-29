import { createHash } from 'crypto'

/**
 * Computes a SHA1 hash for the given string content.
 * @param content The string content to hash.
 * @returns A SHA1 hash string.
 */
export function hash(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}
