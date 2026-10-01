export default {
  options: {
    tsPreCompilationDeps: true,

    tsConfig: {
      fileName: 'tsconfig.json',
    },

    doNotFollow: {
      path: 'node_modules',
      dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer'],
    },
  },

  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies are not allowed',
      from: {
        path: '^src',
      },
      to: {
        circular: true,
      },
    },

    {
      name: 'no-production-dev-deps',
      severity: 'error',
      // bin/ is covered too: it is the only other code the production image
      // runs (`yarn migrate` -> check-migration-versions.js,
      // check-migration-directives.js, dbmate.js), and the image installs
      // dependencies only, so a devDependency there is not a lint nit — it
      // exits non-zero at startup and fails every app install.
      comment: 'Application code must not import non-production dependencies',
      from: {
        path: '^(src|bin)',
        pathNot: ['\\.test\\.ts$', '__tests__/'],
      },
      to: {
        dependencyTypes: ['npm-dev', 'npm-optional', 'npm-peer'],
      },
    },

    {
      name: 'no-cross-domain-internals',
      severity: 'error',
      comment: 'Only import another domain via its public barrel; do not reach into its internals.',
      from: {
        path: '^src/domains/([^/]+)/',
      },
      to: {
        path: '^src/domains/',
        pathNot: [
          '^src/domains/$1/',
          '^src/domains/[^/]+/index\\.ts$',
          '^src/domains/[^/]+/events\\.ts$',
          // Not a domain. Shared TEST machinery sits above the domains precisely
          // because every domain's specs need it — the capture group reads the
          // first path segment, so without this `src/domains/__tests__/` looks
          // like a domain called `__tests__` and importing it looks like reaching
          // into another domain's internals.
          '^src/domains/__tests__/',
        ],
      },
    },

    {
      name: 'no-intra-domain-via-barrel',
      severity: 'error',
      comment: "Within a domain, import modules directly; do not go through that domain's public barrel.",
      from: {
        path: '^src/domains/([^/]+)/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        path: '^src/domains/$1/index\\.ts$',
      },
    },
  ],
};
