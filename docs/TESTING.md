# Testing Guidelines

This document outlines the testing standards and best practices for this project. Comprehensive testing is crucial to ensure the reliability, maintainability, and quality of the codebase.

## Testing Philosophy

We aim for near 100% test coverage. The goal is to write meaningful, behavior-driven tests that:

- Core Logic: All primary functionalities must be thoroughly tested.
- Edge Cases: Consider invalid inputs, empty values, boundary limits, and unexpected scenarios.
- Error Handling: Ensure that the system handles errors gracefully and predictably.
- Schema Validation: All data entering and leaving the public API should be validated against the expected schema.

Important: Never change code just to make tests pass. Code must remain sensible, maintainable, and correct. Tests should probe for edge cases and catch defects, not enforce hacks.

## Tech Stack

- Test Runner: Vitest
- Coverage: c8 (via vitest coverage)

## Validation

Runtime validation is implemented in `src/validation.ts` and enforced in the public API (`src/index.ts`). Tests under `test/validation.test.ts` and `test/index-validation.test.ts` verify that malformed inputs are rejected and that valid inputs proceed correctly.

## Mocks and Isolation

- External systems (PostgreSQL client, embeddings, tokenizers) are mocked in tests to ensure speed and determinism.
- See existing tests for examples using `vi.mock` and spy functions.
- Embedding provider is mocked to return deterministic vectors. If multiple shapes are possible (e.g., array outputs), add cases to verify flexible handling.

## How to Write Tests

- File Naming: `*.test.ts` in the `test/` directory.
- Structure: Use `describe` blocks for grouping and `it` for individual cases. Use `beforeEach`/`afterEach` for setup/teardown.
- Assertions: Use Vitest's `expect` API. Prefer explicit, readable assertions.
- Coverage: Add tests that cover branches and error paths. For example, invalid inputs, empty query handling, clamping options, and missing SQL paths.

## Running Tests

```bash
# Run all tests (watch mode)
npm test

# Run tests once and generate a coverage report
npm run test:cov
```

Coverage reports will be generated in the `coverage/` directory.
