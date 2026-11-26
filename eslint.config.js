const globals = require('globals');

module.exports = [
  {
    files: ['**/*.{js,mjs,cjs}'],
    ignores: ['dist/**', 'node_modules/**', '.atl/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, PRICING: 'readonly' }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none' }],
      'no-unreachable': 'error'
    }
  }
];
