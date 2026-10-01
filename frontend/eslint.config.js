import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', '.wrangler/**', 'node_modules/**', 'src/api/openapi.ts', 'public/guest/**', '**/*.config.js'],
  },
  { files: ['public/theme.js'], languageOptions: { globals: globals.browser } },
  js.configs.recommended,
  { files: ['public/app-updates.js', 'src/app-updates.test.js'], languageOptions: { globals: { ...globals.browser, ...globals.es2022 } } },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true, allowExportNames: ['useProject', 'loadCursorPages', 'docToMarkdown'] }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    files: ['vite.config.ts', 'vitest.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
