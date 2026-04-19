import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.astro/**', '**/coverage/**'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // TS/TSX project-wide
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      'no-console': ['warn', { allow: ['error', 'warn'] }],
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },

  // Plain JS / MJS — no TS-specific rules
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: { 'no-console': 'off' },
  },

  // Viewer React
  {
    files: ['packages/viewer/**/*.{ts,tsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
    },
  },

  // Exporter CLI — allow console for progress
  {
    files: ['packages/exporter/**/*.ts'],
    rules: { 'no-console': 'off' },
  },

  // Astro env.d.ts uses triple-slash references per Astro convention
  {
    files: ['apps/standalone/src/env.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },
);
