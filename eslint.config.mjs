import eslintShared from './eslint.shared.mjs';

export default [
  {
    ignores: [
      '.yarn',
      '**/dist/**',
      '**/node_modules/**',
      '.pnp.*',
      // Nested git worktrees are full copies of this repo. ESLint does not read
      // .gitignore, so without this it walks them and re-lints every file with
      // the root config instead of the per-workspace ones.
      '.claude/worktrees/**',
      'backend/apps/api/*',
      'frontend/apps/web/*',
      'infrastructure/iframely/**',
    ],
  },

  ...eslintShared,
];
