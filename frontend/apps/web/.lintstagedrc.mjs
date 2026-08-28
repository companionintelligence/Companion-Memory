const YARN = 'yarn workspace @ci/fe-web';

export default {
  // oxlint and eslint are listed separately, not via the `lint:fix` script:
  // Yarn appends script arguments only to the LAST command of
  // `oxlint && eslint`, so routing through the script left oxlint unscoped.
  '**/*.{ts,tsx,js,mjs}': [
    `${YARN} run oxlint --fix`,
    `${YARN} run eslint --fix --cache`,
    () => `${YARN} typecheck`,
  ],
};
