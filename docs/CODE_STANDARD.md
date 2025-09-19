# Code Standard and Architecture Guide

This document outlines the coding standards, architectural patterns, and best practices to be followed when contributing to `thefactory-db`.

## Guiding Principles

- **Clarity and Readability**: Code should be easy to understand for new and existing developers.
- **Consistency**: Adhering to a consistent style across the codebase makes it more maintainable.
- **Reusability**: Design components and modules to be reusable across different projects.
- **Robustness**: Write reliable code with appropriate error handling and validation.

## Architecture Overview

`thefactory-db` is a reusable PostgreSQL wrapper designed to provide powerful hybrid search capabilities by combining full-text search (FTS) with vector similarity search. It is built to be a standalone package that can be used as a local file dependency or published to a private registry.

The core of the architecture revolves around two main content models:

1.  **Documents**: For unstructured text content.
2.  **Entities**: For structured JSON content.

Database connections are managed via a single PostgreSQL connection string, allowing multiple projects to share the same database instance.

### Key Source Modules (`src/`)

-   `src/index.ts`: The public API entry point. It exports the `openDatabase` function, which returns a `Database` instance providing access to the Documents and Entities APIs.
-   `src/types.ts`: Contains all shared TypeScript types and interfaces for function arguments, return values, and database models.
-   `src/connection.ts`: Manages the database connection, schema initialization (from `docs/schema.sql`), and ensures necessary extensions like `pgvector` are enabled.

## Database Schema

The schema is defined in `docs/schema.sql` and includes two primary tables:

-   `documents`: Stores text-based content with columns for `id`, `type`, `content`, `fts` (tsvector), `embedding` (vector), and `metadata` (jsonb).
-   `entities`: Stores JSON-based content with a similar structure, but with a `content` column of type `jsonb`.

Both tables use a trigger to automatically update the `updated_at` timestamp.

## Coding Standards

### Language

-   **TypeScript**: The entire codebase is written in TypeScript. Use modern ESNext features where appropriate.
-   **Strict Mode**: `tsconfig.json` should be configured with strict type-checking options enabled (`"strict": true`).

### Formatting and Linting

-   **Prettier**: All code should be formatted with Prettier to ensure a consistent style. A `.prettierrc` file should define the formatting rules.
-   **ESLint**: ESLint is used for identifying and fixing stylistic and programmatic errors. A `.eslintrc.js` file should define the linting rules.

### Naming Conventions

-   **Variables and Functions**: Use `camelCase` (e.g., `myVariable`, `calculateValue`).
-   **Classes, Types, and Interfaces**: Use `PascalCase` (e.g., `Document`, `OpenDbOptions`).
-   **Constants**: Use `UPPER_CASE_SNAKE` for constants that are hard-coded and reused (e.g., `DEFAULT_LIMIT`).
-   **Files**: Use `kebab-case` for filenames (e.g., `hybrid-search.ts`).

### Asynchronous Code

-   **`async/await`**: Always use `async/await` for handling promises. Avoid using `.then()` and `.catch()` chains for asynchronous flows.
-   **Promise-based APIs**: All asynchronous functions should return a `Promise`.

### Error Handling

-   Use `try...catch` blocks to handle exceptions in `async` functions.
-   Errors should be descriptive and provide enough context to help with debugging.
-   For the public-facing API, avoid leaking implementation details in error messages.

### Modules and Imports

-   **ES Modules**: Use ES module syntax (`import`/`export`).
-   **Barrel Files**: `src/index.ts` serves as the barrel file for exporting the public API.
-   **Relative Paths**: Use relative paths for imports within the `src` directory.

### Documentation

-   **JSDoc**: All public functions, classes, and types should have JSDoc comments explaining their purpose, parameters, and return values.
-   **Markdown Documents**: Keep `README.md` and other documents in the `docs/` directory updated with any architectural changes.

By following these standards, we ensure that `thefactory-db` remains a high-quality, maintainable, and easy-to-use library.