// Lint rules for the server (Node), the page (browser) and the tests. Formatting is Prettier's job, not ESLint's.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-shadow': 'error',
      'no-param-reassign': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      complexity: ['warn', 15],
      'max-lines-per-function': ['warn', { max: 60, skipBlankLines: true, skipComments: true }],
    },
  },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
  { files: ['test/**/*.js', 'e2e/**/*.js'], rules: { 'max-lines-per-function': 'off' } },
  // Callbacks passed to page.evaluate() run in the browser.
  { files: ['e2e/**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } } },
];
