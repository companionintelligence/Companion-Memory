import { prettierWrite } from '../../../scripts/lint-staged-prettier.mjs';

const YARN = 'yarn workspace @ci/fe-web';

export default {
  // oxlint and eslint are listed separately, not via the `lint:fix` script:
  // Yarn appends script arguments only to the LAST command of
  // `oxlint && eslint`, so routing through the script left oxlint unscoped.
  //
  // oxlint takes `--no-error-on-unmatched-pattern`, as in the root
  // `.lintstagedrc` that this config replaces. `.oxlintrc.json` ignores the
  // generated GraphQL client (`src/graphql/gql.ts`, `graphql.ts`, ...) and the
  // vendored `src/components/ui/`, so a commit that stages only those, such as
  // a bare `make graphql`, leaves oxlint no file to lint, and without the flag
  // it exits 1 with "No files found to lint". eslint only warns about an
  // ignored file and Prettier skips it via the root ignore files, so oxlint is
  // the one task that needs the flag.
  //
  // Prettier runs last, after eslint's `--fix`. This config replaces the root
  // `.lintstagedrc` for every file under this directory, so without this line
  // Prettier never ran on a web file at commit time.
  '**/*.{ts,tsx,js,mjs}': [
    `${YARN} run oxlint --fix --no-error-on-unmatched-pattern`,
    `${YARN} run eslint --fix --cache`,
    prettierWrite,
    () => `${YARN} typecheck`,
  ],
};
