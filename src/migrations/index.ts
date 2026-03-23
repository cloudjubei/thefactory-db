import type { Migration } from './types.js'
import { migration001 } from './001-init.js'

export const migrations: Migration[] = [migration001]
