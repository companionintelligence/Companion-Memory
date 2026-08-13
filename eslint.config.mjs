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
      '.worktrees/**',
      // Same reason: the uv workspace's virtualenv. Several Python packages
      // ship browser JS inside site-packages (torch and scikit-learn both do),
      // and linting a vendored bundle with this repo's rules is meaningless.
      '**/.venv/**',
      // Generated build output. Prettier and oxlint already skip these; ESLint
      // only had dist, so bundled vendor JS (video/build/runtime/vendor) leaked in.
      '**/build/**',
      // Capacitor copies the built web bundle into the native projects on
      // `cap sync`, and Xcode copies it again into DerivedData on build. All are
      // gitignored, but by the nested .gitignore files under ios/ and android/,
      // which ESLint never reads — it does not consult .gitignore at all.
      'frontend/apps/mobile/ios/App/App/public/**',
      'frontend/apps/mobile/android/app/src/main/assets/public/**',
      // Capital B, so the '**/build/**' entry above does not cover it.
      'frontend/apps/mobile/ios/App/DerivedData/**',
      'backend/apps/api/*',
      'frontend/apps/web/*',
      'infrastructure/iframely/**',
    ],
  },

  ...eslintShared,
];
