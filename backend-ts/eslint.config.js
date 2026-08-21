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
  { ignores: ['node_modules/**', 'dist/**'] },
)
