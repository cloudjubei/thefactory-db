# Code Standard and Architecture

A concise guide to how we build and maintain thefactory-db.

Purpose: a typed, reusable Postgres wrapper offering hybrid search (FTS + pgvector) over two content models: Documents (text) and Entities (JSON).

Architecture
- Public API: src/index.ts exports openDatabase(options) -> TheFactoryDb (documents + entities methods, and raw()).
- Connection & schema: src/connection.ts opens a pg Client and applies schema/functions from embedded SQL in src/utils.ts. Reference SQL scripts live under docs/sql for humans; runtime uses embedded statements.
- Types: src/types.ts contains all public types and shared interfaces.
- Utilities: src/utils/* houses embeddings, tokenizer, and JSON value stringification.

Language & Modules
- TypeScript with strict mode enabled (tsconfig.json).
- ESM everywhere. Use .js extensions for relative imports in source (e.g., import './types.js') so emitted code resolves correctly.
- Prefer named exports for public API.

Style
- Prettier for formatting (see .prettierrc.json).
- ESLint for correctness/consistency (.eslintrc.cjs).
- Naming: camelCase (vars/functions), PascalCase (types/classes), UPPER_SNAKE (constants), kebab-case for filenames when applicable.

APIs & Types
- Public functions and types exported from src/index.ts and src/types.ts must have concise JSDoc (purpose, params, returns).
- Prefer explicit parameter and return types. Avoid any in public types.

Async & Errors
- Use async/await.
- Bubble errors by default; add try/catch only to add context or to clean up (e.g., closing a connection on failure). Never swallow errors silently.

SQL & Security
- Always use parameterized queries ($1, $2, ...) — never build SQL with user input via string concatenation.
- Vector dimension defaults to 384. Required extensions (pgcrypto, vector) are created idempotently by the schema.

Logging
- Use createLogger(level) for internal tracing; default level is 'info'. Keep logs concise, especially in hot paths.

Testing & Docs
- See docs/TESTING.md for guidance.
- Keep README.md and docs/FILE_ORGANISATION.md up to date when public API or architecture changes.
