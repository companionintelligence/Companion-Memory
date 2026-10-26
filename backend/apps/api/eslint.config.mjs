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

  {
    // This package is written against the zod 3 API, which zod 4 still ships
    // unchanged at `zod/v3`. The bare `zod` specifier is the v4 API: `.default()`
    // no longer parses its value (a nested `.default({})` stops filling in the
    // inner defaults, which src/configuration.ts leans on), `z.record()` needs a
    // key schema, and `.uuid()` is strict about the RFC variant. A new file that
    // imported it would not so much fail to compile as quietly behave
    // differently, so the specifier itself is restricted. A syntax rule rather
    // than no-restricted-imports: the root config already defines that one, and
    // a second definition replaces the first instead of adding to it.
    files: ['**/*.ts', 'bin/**/*.js'],

    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value='zod'], ExportAllDeclaration[source.value='zod'], ExportNamedDeclaration[source.value='zod'], ImportExpression[source.value='zod'], CallExpression[callee.name='require'][arguments.0.value='zod']",
          message: "Import zod from 'zod/v3': this package is written against the zod 3 API.",
        },
      ],
    },
  },
];
