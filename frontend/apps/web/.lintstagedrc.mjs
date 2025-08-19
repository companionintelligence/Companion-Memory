const YARN = 'yarn workspace @ci/fe-web';

export default {
  '**/*.{ts,tsx,js,mjs}': [`${YARN} lint:fix`, () => `${YARN} typecheck`],
};
