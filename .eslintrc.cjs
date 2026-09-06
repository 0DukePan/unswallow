# Dev-only tooling for the monorepo root. The published packages ship no
# eslint dependency — this config exists so CI can lint the TypeScript
# sources with a single eslint binary at the root.
root: true
parser: '@typescript-eslint/parser'
parserOptions:
  sourceType: module
  ecmaVersion: 2022
plugins:
  - '@typescript-eslint'
extends:
  - eslint:recommended
  - plugin:@typescript-eslint/recommended
ignorePatterns:
  - packages/unswallow/dist/
  - packages/matrix/node_modules/
  - '**/node_modules/**'
rules:
  # Leave this on for correctness-sensitive scanning code.
  no-unreachable: error
  no-constant-condition: off
  no-fallthrough: off
  no-empty:
    - error
    - allowEmptyCatch: true
  '@typescript-eslint/no-explicit-any': off
  '@typescript-eslint/no-unused-vars':
    - warn
    - argsIgnorePattern: '^_'
      varsIgnorePattern: '^_'
  '@typescript-eslint/no-non-null-assertion': off
