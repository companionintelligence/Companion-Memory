import globals from 'globals';

import eslintShared from './eslint.shared.mjs';

export default [
  {
    ignores: [
      '.yarn',
      '**/dist/**',
      // Prettier and oxlint both ignore build output generally; ESLint only
      // listed dist plus specific native build dirs, so bundled vendor JS
      // under other build/ trees still got linted with this repo's rules.
      '**/build/**',
      '**/node_modules/**',
      '.pnp.*',
      // Local-only generated viz + scratch (gitignored; ESLint does not
      // read .gitignore). Compodoc/ChartDB vendor JS is not ours.
      '.local/**',
      'tools/**',
      // Nested git worktrees are full copies of this repo. ESLint does not read
      // .gitignore, so without this it walks them and re-lints every file with
      // the root config instead of the per-workspace ones.
      '.claude/worktrees/**',
      '.worktrees/**',
      // lottie-web, vendored into the desktop bootstrap page rather than loaded
      // from a CDN: that page runs under the app's own CSP (`script-src 'self'`),
      // so a remote script would simply be blocked. It is minified upstream
      // output — linting it reports thousands of errors in code that is not ours
      // and that we do not edit.
      'frontend/apps/desktop/bootstrap/lottie.min.js',
      // The Safari Web Extension's Resources/ is filled at build time from
      // CI-Browser-Extension (see frontend/apps/ios/scripts/sync-safari-extension.sh)
      // and is gitignored — but, again, ESLint does not read .gitignore. Without
      // this, `yarn lint` reports ~8,000 errors in vendored bundle output the
      // moment anyone builds iOS locally. CI never sees it, because CI lints a
      // fresh checkout that has never run the sync.
      'frontend/apps/ios/ios/App/SafariWebExtension/Resources/**',
      // Same reason: the uv workspace's virtualenv. Several Python packages
      // ship browser JS inside site-packages (torch and scikit-learn both do),
      // and linting a vendored bundle with this repo's rules is meaningless.
      '**/.venv/**',
      // Capacitor-generated native output. `cap sync` copies the minified
      // @ci/fe-web bundle into frontend/apps/ios and frontend/apps/android, and the
      // native builds copy it again into their product dirs. Linting ~95
      // minified chunks per platform buries the real output under six figures
      // of errors in code we did not write. oxlint skips them on its own (it
      // reads frontend/apps/ios/.gitignore / android/.gitignore); ESLint reads no .gitignore, so
      // it needs the paths spelled out. Keep in sync with .prettierignore.
      'frontend/apps/ios/ios/App/App/public/**',
      'frontend/apps/ios/ios/App/Pods/**',
      'frontend/apps/ios/ios/App/build/**',
      'frontend/apps/ios/ios/App/DerivedData/**',
      'frontend/apps/ios/ios/DerivedData/**',
      'frontend/apps/ios/ios/capacitor-cordova-ios-plugins/**',
      'frontend/apps/android/android/app/src/main/assets/public/**',
      'frontend/apps/android/android/app/build/**',
      'frontend/apps/android/android/build/**',
      'frontend/apps/android/android/capacitor-cordova-android-plugins/**',
      'backend/apps/api/*',
      'frontend/apps/web/*',
      'infrastructure/iframely/**',
    ],
  },

  ...eslintShared,

  {
    // The Tauri bootstrap splash (frontend/apps/desktop/bootstrap) runs directly
    // in the webview, not under Node — it needs `window`/`document` etc. rather
    // than the Node globals eslint.shared.mjs applies to every other **/*.js.
    files: ['frontend/apps/desktop/bootstrap/**/*.js'],

    languageOptions: {
      globals: globals.browser,
    },
  },

  {
    // eslint.shared.mjs's `**/*.js` glob doesn't match `.cjs`, so these plain
    // CommonJS entry points (deliberately dependency-free, same reasoning as
    // bin/check-migration-versions.js) get neither Node globals nor an
    // exemption from the ESM-authoring `no-require-imports` rule.
    //
    // @ci/cli's is the `ci-import` deprecation shim: it prints a notice to
    // stderr and requires the bundle, so it has to run from `bin/` in the
    // installed package before any resolution the bundle would do for itself.
    //
    // frontend/apps/android/scripts/dev-android.cjs is what `yarn android` runs
    // under Node, outside the Yarn workspaces (see that app's README).
    files: [
      'frontend/apps/desktop/scripts/*.cjs',
      'frontend/apps/android/scripts/*.cjs',
      'backend/apps/cli/bin/*.cjs',
    ],

    languageOptions: {
      globals: globals.node,
    },

    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  {
    // `@ci/common/schedule` wraps Nest's `Cron` with the three things the Jobs
    // dashboard depends on: the durable `ci.cron_runs` stamp, a traceId around
    // the tick, and an error log that names the schedule. A cron decorated with
    // the raw import silently loses all three and reads "never run" after every
    // restart. The wrapper itself is the one place that may import it, and only
    // the `Cron` symbol is restricted — `CronExpression` and `SchedulerRegistry`
    // stay importable.
    files: ['**/*.ts'],
    ignores: ['**/src/common/schedule/**'],

    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/schedule',
              importNames: ['Cron'],
              message: "Import Cron from '@ci/common/schedule' instead.",
            },
          ],
        },
      ],
    },
  },
];
