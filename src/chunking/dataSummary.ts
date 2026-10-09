import {
  DATA_FILE_DIGIT_RATIO,
  DATA_FILE_EXTS,
  DATA_FILE_MIN_CHARS,
  DATA_FILE_SAMPLE_CHARS,
  DATA_SAMPLE_MAX_CHARS,
  DATA_SKETCH_MAX_DEPTH,
  DATA_SKETCH_MAX_LINES,
  DATA_SKETCH_MAX_RECORDS,
} from './chunkingConstants.js'

/**
 * Whether a file is bulk data to summarise rather than chunk: a data extension, and either large or
 * mostly digits. Chunk vectors of price series or numeric tables carry next to no meaning.
 */
export function isDataFile(ext: string, content: string): boolean {
  if (!DATA_FILE_EXTS.has(ext)) return false
  if (content.length >= DATA_FILE_MIN_CHARS) return true
  const sample = content.slice(0, DATA_FILE_SAMPLE_CHARS)
  const digits = sample.replace(/[^0-9]/g, '').length
  return digits > sample.length * DATA_FILE_DIGIT_RATIO
}

const isContainer = (value: unknown): value is object => value !== null && typeof value === 'object'

/** `string`, `null`, `object`, … or `array(n) of <first element's kind>`. */
function typeOf(value: unknown): string {
  if (!Array.isArray(value)) return value === null ? 'null' : typeof value
  if (value.length === 0) return 'array(0)'
  const first = Array.isArray(value[0]) ? 'array' : typeOf(value[0])
  return `array(${value.length}) of ${first}`
}

/** `path: type` lines for a JSON value, descending into objects and the first element of arrays. */
function sketch(value: unknown, path: string, depth: number, lines: string[]): void {
  if (lines.length >= DATA_SKETCH_MAX_LINES) return
  lines.push(`${path || '$'}: ${typeOf(value)}`)
  if (depth >= DATA_SKETCH_MAX_DEPTH || !isContainer(value)) return
  if (Array.isArray(value)) {
    if (isContainer(value[0])) sketch(value[0], `${path}[]`, depth + 1, lines)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    sketch(child, path ? `${path}.${key}` : key, depth + 1, lines)
  }
}

/** The first element of the largest array in a JSON value, or the value itself. */
function sampleOf(value: unknown): unknown {
  let best: unknown[] | undefined
  const walk = (v: unknown, depth: number) => {
    if (depth > DATA_SKETCH_MAX_DEPTH) return
    if (Array.isArray(v)) {
      if (!best || v.length > best.length) best = v
      if (v.length > 0) walk(v[0], depth + 1)
    } else if (isContainer(v)) {
      for (const child of Object.values(v)) walk(child, depth + 1)
    }
  }
  walk(value, 0)
  return best && best.length > 0 ? best[0] : value
}

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`

function clip(text: string): string {
  return text.length > DATA_SAMPLE_MAX_CHARS ? `${text.slice(0, DATA_SAMPLE_MAX_CHARS)}…` : text
}

function summarizeJson(content: string, lineDelimited: boolean): string {
  const records = lineDelimited ? content.split('\n').filter((l) => l.trim()) : []
  let value: unknown
  try {
    value = lineDelimited
      ? records.slice(0, DATA_SKETCH_MAX_RECORDS).map((l) => JSON.parse(l))
      : JSON.parse(content)
  } catch {
    return `Data file: JSON (unparseable)\n${clip(content)}`
  }
  const lines: string[] = []
  sketch(value, '', 0, lines)
  const count = lineDelimited ? `, ${counted(records.length, 'record')}` : ''
  return `Data file: JSON${count}\n${lines.join('\n')}\nSample: ${clip(JSON.stringify(sampleOf(value)))}`
}

function summarizeTable(content: string, separator: string): string {
  const lines = content.split('\n').filter((l) => l.trim())
  const header = (lines[0] ?? '').split(separator).map((c) => c.trim())
  return [
    `Data file: table, ${counted(Math.max(lines.length - 1, 0), 'row')}`,
    `columns: ${header.join(', ')}`,
    'Sample:',
    ...lines.slice(1, 3).map(clip),
  ].join('\n')
}

/** A short description of a data file: its structure and one sample record. */
export function summarizeDataFile(ext: string, content: string): string {
  if (ext === 'csv') return summarizeTable(content, ',')
  if (ext === 'tsv') return summarizeTable(content, '\t')
  return summarizeJson(content, ext === 'jsonl' || ext === 'ndjson')
}
