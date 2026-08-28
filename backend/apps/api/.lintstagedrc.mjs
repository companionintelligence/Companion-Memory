const YARN = 'yarn workspace @ci/be-api';

export default {
  // oxlint and eslint are listed separately, not via the `lint:fix` script.
  // lint-staged appends the staged filenames to a string command, but Yarn
  // appends script arguments only to the LAST command of `oxlint && eslint`,
  // so routing through the script left oxlint unscoped — every commit was
  // gated on oxlint errors anywhere in the workspace.
  '**/*.{ts,js,mjs}': [
    `${YARN} run oxlint --fix`,
    `${YARN} run eslint --fix --cache`,
    () => `${YARN} typecheck`,
    () => `${YARN} depcheck`,
  ],
  'db/postgres/migrations/*.sql': [() => `${YARN} check:migrations`],
};
