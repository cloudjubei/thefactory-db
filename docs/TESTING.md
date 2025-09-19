# Testing Guidelines

This document outlines the testing standards and best practices for this project. Comprehensive testing is crucial to ensure the reliability, maintainability, and quality of the codebase.

## Testing Philosophy

We aim for near 100% test coverage. While this is a goal, the primary focus should be on writing meaningful tests that cover:

-   **Core Logic**: All primary functionalities must be thoroughly tested.
-   **Edge Cases**: Consider invalid inputs, empty values, and unexpected scenarios.
-   **Error Handling**: Ensure that the system handles errors gracefully.
-   **Schema Validation**: All data entering and leaving the system should be validated against its expected schema.

## Tech Stack

-   **Test Runner**: [Vitest](https://vitest.dev/)
-   **Coverage**: [c8](https://github.com/bcoe/c8)

## How to Write Tests

-   **File Naming**: Test files should be named `*.test.ts` and placed in the `test/` directory.
-   **Mocking**: All external dependencies (e.g., databases, external APIs, file system) must be mocked. This ensures that tests are fast, reliable, and run in isolation. Vitest provides powerful mocking capabilities. See `vi.mock` in the existing tests for examples.
-   **Assertions**: Use the `expect` assertion library from Vitest for clear and readable assertions.
-   **Structure**: Use `describe` to group related tests and `it` for individual test cases. Use `beforeEach` and `afterEach` to set up and tear down test conditions.

## Running Tests

To run the tests, use the following scripts from `package.json`:

```bash
# Run all tests
npm test

# Run tests and generate a coverage report
npm run test:cov
```

The coverage report will be generated in the `coverage/` directory.
