# Testing Guidelines

This document outlines the testing standards and best practices for this project. Comprehensive testing is crucial to ensure the reliability, maintainability, and quality of the codebase.

### ATOMICITY
Tests should be as atomic as they can be. One test file per one code file. In every file, each test should be checking a single code path or a single return. One unit test shouldn't be testing the same function multiple times, other than to test out the difference in flow or data stored between multiple runs (if there's any need for that).

## Core Principles

### Isolate Tests with Mocks
Unit tests **must** be isolated from external services. All dependencies—including repositories, external providers (Cognito, AI services), and other services—must be mocked. This ensures tests are fast, deterministic, and do not rely on network or live credentials. Mocks should be configured to test a variety of scenarios, including successful responses, error conditions, and malformed data, to ensure the service under test is resilient.

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
