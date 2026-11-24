import { prettierWrite } from '../../../scripts/lint-staged-prettier.mjs';

const YARN = 'yarn workspace @ci/be-api';

export default {
  // oxlint and eslint are listed separately, not via the `lint:fix` script.
  // lint-staged appends the staged filenames to a string command, but Yarn
  // appends script arguments only to the LAST command of `oxlint && eslint`,
  // so routing through the script left oxlint unscoped — every commit was
  // gated on oxlint errors anywhere in the workspace.
  //
  // Prettier runs last, after eslint's `--fix`: eslint's `curly` fix writes
  // an inline `{ return x; }` that Prettier then wraps. This config replaces
  // the root `.lintstagedrc` for every file under this directory, so without
  // this line Prettier never ran on a be-api file at commit time.
  '**/*.{ts,js,mjs}': [
    `${YARN} run oxlint --fix`,
    `${YARN} run eslint --fix --cache`,
    prettierWrite,
    () => `${YARN} typecheck`,
    () => `${YARN} depcheck`,
  ],
  'db/postgres/migrations/*.sql': [() => `${YARN} check:migrations`],
};
