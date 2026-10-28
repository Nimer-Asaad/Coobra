import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', '.e2e-dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Nest injects classes by runtime type, so `import type` would break DI.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
);
