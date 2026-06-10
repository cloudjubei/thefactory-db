import type { Migration } from './types.js'
import { migration001 } from './001-init.js'
import { migration002 } from './002-entities-project-updated-at-index.js'
import { migration003 } from './003-entities-external-key.js'
import { migration004 } from './004-entities-should-embed-repair.js'

export const migrations: Migration[] = [migration001, migration002, migration003, migration004]
