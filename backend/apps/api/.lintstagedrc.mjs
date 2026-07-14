const YARN = 'yarn workspace @ci/be-api';

export default {
  '**/*.{ts,js,mjs}': [`${YARN} lint:fix`, () => `${YARN} typecheck`, () => `${YARN} depcheck`],
  'db/postgres/migrations/*.sql': [() => `${YARN} check:migrations`],
};
