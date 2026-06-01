import type { Migration } from './types.js'
import { migration001 } from './001-init.js'
import { migration002 } from './002-entities-project-updated-at-index.js'
import { migration003 } from './003-entities-external-key.js'

export const migrations: Migration[] = [migration001, migration002, migration003]
