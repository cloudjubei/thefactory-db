module.exports = {
  root: true,
  env: { node: true, es2020: true },
  parser: '@typescript-eslint/parser',
  parserOptions: { project: null, sourceType: 'module', ecmaVersion: 'latest' },
  plugins: ['@typescript-eslint', 'import'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:import/recommended',
    'plugin:import/typescript',
    'prettier',
  ],
  settings: {
    'import/resolver': { typescript: true, node: true },
  },
  rules: {
    'import/order': [
      'warn',
      { 'newlines-between': 'always', alphabetize: { order: 'asc', caseInsensitive: true } },
    ],
  },
  ignorePatterns: ['dist', 'node_modules'],
};
