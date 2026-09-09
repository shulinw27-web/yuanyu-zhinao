import js from '@eslint/js';
import globals from 'globals';
import pluginVue from 'eslint-plugin-vue';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/release/**',
      '**/coverage/**',
      '**/.venv*/**',
      '.playwright-cli/**',
      'docs/.artifact-build/**',
      'backend/runtime-data/**',
      'backend/src/data/mock-records.json'
    ]
  },
  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['**/*.{js,mjs,cjs,vue}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['log', 'warn', 'error'] }],
      'no-duplicate-imports': 'error',
      'no-control-regex': 'off',
      'vue/multi-word-component-names': 'off'
    }
  }
];
