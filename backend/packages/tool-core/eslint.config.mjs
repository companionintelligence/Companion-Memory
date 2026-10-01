import { fileURLToPath } from 'node:url';

import globals from 'globals';
import importPlugin from 'eslint-plugin-import';

import base from '../../../eslint.config.mjs';

export default [
  {
    ignores: ['.yarn', '**/dist/**', '**/node_modules/**', '.pnp.*'],
  },

  ...base,

  {
    files: ['**/*.ts'],

    languageOptions: {
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
      // Matches backend/apps/api's ordering so a file can be moved between the
      // two without the import block being rewritten.
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
