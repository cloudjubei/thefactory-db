import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript'
import { createNodeResolver, importX } from 'eslint-plugin-import-x'
import globals from 'globals'
import { config, configs } from 'typescript-eslint'

export default config(
  { ignores: ['dist/', 'coverage/', '.coverage-v8/', '.stories/', '.factory/'] },
  js.configs.recommended,
  configs.recommended,
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    languageOptions: { globals: globals.node },
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver(), createNodeResolver()],
    },
    rules: {
      'no-control-regex': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'import-x/order': [
        'error',
        {
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
          pathGroups: [
            {
              pattern: '{./,../,../../}utils/unitTestMocks',
              group: 'parent',
              position: 'before',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
    },
  },
  prettier,
)
