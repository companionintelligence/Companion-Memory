const YARN = 'yarn workspace @ci/be-api';

export default {
  '**/*.{ts,tsx,js,mjs}': [`${YARN} lint:fix`, () => `${YARN} typecheck`],
};
