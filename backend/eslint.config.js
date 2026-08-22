import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Scripts and tests are the places stdout *is* the output, not a log line.
    files: ['src/scripts/**/*.ts', 'src/tests/**/*.ts', 'src/**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  // ——— Architecture boundaries ———
  // The layering CLAUDE.md describes, as lint rules. Only `http/`, `main.ts`
  // and the entry points may import `http/` or `orchestration/`; `crud/` stays
  // pure CRUD (type-only reaches upward are tolerated — they cannot create a
  // runtime cycle). Cycle detection itself is `bun run check-cycles`.
  {
    files: [
      'src/auth/**/*.ts',
      'src/config/**/*.ts',
      'src/db/**/*.ts',
      'src/domain/**/*.ts',
      'src/infrastructure/**/*.ts',
      'src/lib/**/*.ts',
      'src/schemas/**/*.ts',
      'src/sdk/**/*.ts',
      'src/services/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/http/**'],
              message:
                'Layers below http/ must not import it. HttpError lives in domain/errors.ts.',
            },
            {
              group: ['**/orchestration/**'],
              message:
                'Only http/ and main.ts drive orchestration; lower layers report through callbacks (see ServerDeps).',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/orchestration/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/http/**'],
              message: 'orchestration/ is driven by http/, never the reverse.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/crud/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/http/**', '**/orchestration/**'],
              message: 'crud/ sits below http/ and orchestration/.',
            },
            {
              group: ['**/services/**', '**/sdk/**'],
              allowTypeImports: true,
              message:
                'crud/ is pure CRUD — value imports from services/ or sdk/ invert the layering (types are fine).',
            },
          ],
        },
      ],
    },
  },
  { ignores: ['node_modules/**', 'dist/**'] },
)
