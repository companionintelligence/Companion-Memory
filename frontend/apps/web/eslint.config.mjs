import { fileURLToPath } from 'node:url';

import globals from 'globals';
import importPlugin from 'eslint-plugin-import';

import base from '../../../eslint.shared.mjs';

const importOrderRules = {
  'import/order': [
    'error',
    {
      groups: ['builtin', 'external', 'internal', 'parent', ['sibling', 'index']],
      pathGroups: [
        {
          pattern: 'react',
          group: 'external',
          position: 'before',
        },
        {
          pattern: '@/**',
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
};

export default [
  {
    ignores: [
      '.yarn',
      '**/dist/**',
      '**/dev-dist/**',
      '**/node_modules/**',
      '.pnp.*',
      // GraphQL codegen output (mirrors .prettierignore / root .oxlintrc.json):
      // eslint --fix strips their /* eslint-disable */ banners as "unused".
      'src/graphql/index.ts',
      'src/graphql/gql.ts',
      'src/graphql/graphql.ts',
      'src/graphql/fragment-masking.ts',
      'src/graphql/possibleTypes.ts',
    ],
  },

  ...base,

  // All TypeScript files - shared settings
  {
    files: ['**/*.ts', '**/*.tsx'],

    languageOptions: {
      parserOptions: {
        projectService: true,
        // A path string, not a URL: typescript-estree throws on any non-string value.
        tsconfigRootDir: fileURLToPath(new URL('.', import.meta.url)),
      },
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

    rules: importOrderRules,
  },

  // React app source files - browser environment
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'stories/**/*.ts', 'stories/**/*.tsx'],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Config files, scripts, storybook - Node.js environment
  {
    files: ['*.config.ts', 'codegen.ts', 'scripts/**/*.ts', '.storybook/**/*.ts', '.storybook/**/*.tsx'],
    languageOptions: {
      globals: globals.node,
    },
  },
];
