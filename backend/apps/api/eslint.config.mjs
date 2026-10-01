import { fileURLToPath } from 'node:url';

import globals from 'globals';
import importPlugin from 'eslint-plugin-import';

import base from '../../../eslint.config.mjs';

export default [
  {
    ignores: [
      '.yarn',
      '**/dist/**',
      '**/docs/**',
      '**/node_modules/**',
      '.pnp.*',
      // Importer test fixtures are verbatim copies of real vendor export
      // archives — Twitter/X ships its data as `.js` files assigning to
      // `window.YTD.*`. They are data under test, not source, and linting them
      // only reports on the vendor's formatting.
      '**/__tests__/fixtures/**',
    ],
  },

  ...base,

  {
    files: ['**/*.ts'],

    languageOptions: {
      // Using projectService for better performance - shares TS project with IDE
      parserOptions: {
        projectService: true,
        // A path string, not a URL: typescript-estree throws on any non-string value.
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      globals: globals.node,
    },

    plugins: {
      import: importPlugin,
    },

    settings: {
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
      },
    },

    rules: {
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', ['sibling', 'index']],
          pathGroups: [
            {
              pattern: '@ci/**',
              group: 'internal',
              position: 'after',
            },
          ],
          pathGroupsExcludedImportTypes: ['builtin'],
          'newlines-between': 'always',
          alphabetize: {
            order: 'asc',
            caseInsensitive: true,
          },
        },
      ],
    },
  },
];
