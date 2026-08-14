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
      // Same reason: the uv workspace's virtualenv. Several Python packages
      // ship browser JS inside site-packages (torch and scikit-learn both do),
      // and linting a vendored bundle with this repo's rules is meaningless.
      '**/.venv/**',
      // Capacitor-generated native output. `cap sync` copies the minified
      // @ci/fe-web bundle into frontend/apps/mobile/{ios,android}, and the
      // native builds copy it again into their product dirs. Linting ~95
      // minified chunks per platform buries the real output under six figures
      // of errors in code we did not write. oxlint skips them on its own (it
      // reads frontend/apps/mobile/.gitignore); ESLint reads no .gitignore, so
      // it needs the paths spelled out. Keep in sync with .prettierignore.
      'frontend/apps/mobile/ios/App/App/public/**',
      'frontend/apps/mobile/ios/App/Pods/**',
      'frontend/apps/mobile/ios/App/build/**',
      'frontend/apps/mobile/ios/App/DerivedData/**',
      'frontend/apps/mobile/ios/DerivedData/**',
      'frontend/apps/mobile/ios/capacitor-cordova-ios-plugins/**',
      'frontend/apps/mobile/android/app/src/main/assets/public/**',
      'frontend/apps/mobile/android/app/build/**',
      'frontend/apps/mobile/android/build/**',
      'frontend/apps/mobile/android/capacitor-cordova-android-plugins/**',
      'backend/apps/api/*',
      'frontend/apps/web/*',
      'infrastructure/iframely/**',
    ],
  },

  ...eslintShared,
];
