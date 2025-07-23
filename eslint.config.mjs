import eslintShared from './eslint.shared.mjs';

export default [
  {
    ignores: [
      '.yarn',
      '**/dist/**',
      '**/node_modules/**',
      '.pnp.*',
      'backend/apps/api/*',
      'frontend/apps/web/*',
    ],
  },

  ...eslintShared,
];
