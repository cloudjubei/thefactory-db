import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { Language, Parser, type Node } from 'web-tree-sitter'

import { CHUNK_MAX_CHARS, CODE_GRAMMARS, SCOPE_NODE_TYPE } from './chunkingConstants.js'
import type { ChunkSpan } from './chunkingTypes.js'
import { trimSpan, windowSpans } from './spans.js'

const require = createRequire(import.meta.url)
let parserReady: Promise<void> | undefined
const languages = new Map<string, Promise<Language>>()

function loadLanguage(ext: string): Promise<Language> | undefined {
  const grammar = CODE_GRAMMARS[ext]
  if (!grammar) return undefined
  const key = `${grammar.pkg}/${grammar.wasm}`
  let language = languages.get(key)
  if (!language) {
    parserReady ??= Parser.init()
    const wasmPath = path.join(
      path.dirname(require.resolve(`${grammar.pkg}/package.json`)),
      grammar.wasm,
    )
    language = parserReady.then(() => Language.load(fs.readFileSync(wasmPath)))
    languages.set(key, language)
  }
  return language
}

/** The names of the scopes enclosing `node`, outermost first (e.g. `Outer › build › Inner`). */
function scopeOf(node: Node): string {
  const names: string[] = []
  for (let n = node.parent; n; n = n.parent) {
    if (!SCOPE_NODE_TYPE.test(n.type)) continue
    const name = n.childForFieldName('name')?.text
    if (name) names.unshift(name)
  }
  return names.join(' › ')
}

/**
 * Syntax-aware chunks (cAST): consecutive sibling nodes are packed while they fit; a node too large
 * is entered and its children packed in turn, continuing the open group so a declaration's opening
 * (`export class Foo {`) travels with its first member; a leaf too large is cut into line windows.
 * Resolves `undefined` when the extension has no grammar.
 */
export async function chunkCode(content: string, ext: string): Promise<ChunkSpan[] | undefined> {
  const language = await loadLanguage(ext)
  if (!language) return undefined
  const parser = new Parser()
  try {
    parser.setLanguage(language)
    const tree = parser.parse(content)
    if (!tree) return undefined
    try {
      return packNodes(content, tree.rootNode)
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
}

function packNodes(content: string, root: Node): ChunkSpan[] {
  const spans: ChunkSpan[] = []
  let open: ChunkSpan | undefined
  const flush = () => {
    const span = open && trimSpan(content, open)
    if (span) spans.push(span)
    open = undefined
  }
  const visit = (node: Node) => {
    if (node.endIndex - node.startIndex > CHUNK_MAX_CHARS) {
      if (node.childCount > 0) {
        for (const child of node.children) if (child) visit(child)
        return
      }
      flush()
      const context = scopeOf(node)
      spans.push(
        ...windowSpans(content, node.startIndex, node.endIndex, CHUNK_MAX_CHARS, 0, context),
      )
      return
    }
    if (open && node.endIndex - open.start <= CHUNK_MAX_CHARS) {
      open.end = node.endIndex
      return
    }
    flush()
    open = { start: node.startIndex, end: node.endIndex, context: scopeOf(node) }
  }
  for (const child of root.children) if (child) visit(child)
  flush()
  return spans
}
