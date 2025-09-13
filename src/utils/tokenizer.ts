// Tokenizer and FTS normalization utilities
//
// - tokenize: keeps the original behavior returning token ids (for future use)
// - toFtsText: produces a normalized lexical string suitable for FTS5 indexing
//
// We intentionally type js-tiktoken loosely to avoid hard type coupling
// and keep this package buildable even if types are not available.
// Consumers must install the runtime dependency.
import * as jsTiktoken from 'js-tiktoken'

export type TokenizerEncodeResult = {
  tokens: number[]
  tokenCount: number
  tokenizedContent: string // joined representation (space-separated token ids)
}

export type TokenizerOptions = {
  encoding?: jsTiktoken.TiktokenEncoding // e.g., 'cl100k_base'
  strategy?: 'tiktoken' | 'whitespace'
}

// Cache encoders per model to avoid re-instantiating the WASM encoder
const encoderCache: Record<string, any> = {}

function getEncoder(encoding: jsTiktoken.TiktokenEncoding): jsTiktoken.Tiktoken {
  if (!encoderCache[encoding]) {
    encoderCache[encoding] = jsTiktoken.getEncoding(encoding)
  }
  return encoderCache[encoding]
}

export function tokenize(text: string, opts: TokenizerOptions = {}): TokenizerEncodeResult {
  const strategy = opts.strategy ?? 'tiktoken'
  const encoding: jsTiktoken.TiktokenEncoding = opts.encoding ?? 'cl100k_base'

  if (strategy === 'tiktoken') {
    try {
      const enc = getEncoder(encoding)
      if (enc) {
        const tokens: number[] = enc.encode(text)
        return {
          tokens,
          tokenCount: tokens.length,
          tokenizedContent: tokens.join(' '),
        }
      }
      // If encoder not available, fall through to whitespace
    } catch {
      // If encoding fails at runtime, fall through to whitespace
    }
  }

  // Whitespace fallback: map words to simple hashes as token ids
  const words = toWords(text)
  const tokens: number[] = words.map(simpleHash32)
  return { tokens, tokenCount: tokens.length, tokenizedContent: tokens.join(' ') }
}

// Create a normalized lexical representation appropriate for SQLite FTS5.
// Lowercase, strip punctuation/control chars, collapse whitespace.
export function toFtsText(text: string): string {
  const words = toWords(text)
  return words.join(' ')
}

function toWords(text: string): string[] {
  return (
    text
      .toLowerCase()
      // Replace control chars with space
      .replace(/[\u0000-\u001f]/g, ' ')
      // Replace punctuation (keep letters, numbers, underscores) with space
      .replace(/[^\p{L}\p{N}_]+/gu, ' ')
      // Collapse whitespace
      .replace(/[\n\r\t]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  )
}

function simpleHash32(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  // clamp to 31-bit signed positive integer range for readability
  return h & 0x7fffffff
}
