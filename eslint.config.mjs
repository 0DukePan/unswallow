// Dev-only tooling for the monorepo root. The published packages ship no
// eslint dependency — typescript-eslint lives in the root devDependencies
// and never ships in the published artifacts.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['packages/unswallow/dist/**', '**/node_modules/**', 'package-lock.json'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['packages/unswallow/src/**/*.ts', 'packages/unswallow/cli/**/*.ts', 'packages/unswallow/test/**/*.ts', 'packages/bench/**/*.mjs', 'packages/scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      'no-constant-condition': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);
