import type { Migration } from './types.js'
import { migration001 } from './001-init.js'
import { migration002 } from './002-entities-project-updated-at-index.js'
import { migration003 } from './003-entities-external-key.js'
import { migration004 } from './004-entities-should-embed-repair.js'
import { migration005 } from './005-hybrid-search-candidate-limit.js'
import { migration006 } from './006-documents-non-indexable.js'
import { migration007 } from './007-documents-fingerprint.js'
import { migration008 } from './008-document-chunks.js'

export const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
]
