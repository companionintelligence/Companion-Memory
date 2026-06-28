// Type-only augmentation: teaches TypeScript about the jest-dom matchers on
// Vitest's `expect` (toBeInTheDocument, toHaveAttribute, …). The runtime
// `expect.extend` lives in setup.ts; this only adds the types. Declared
// explicitly (rather than importing the `/vitest` subpath) so resolution is
// robust under Yarn PnP.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  // The `any` default must match Vitest's own `Assertion<T = any>` declaration
  // for interface merging to apply. The interfaces only merge in matcher types,
  // so they are intentionally "empty".
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
  interface Assertion<T = any> extends TestingLibraryMatchers<unknown, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<unknown, unknown> {}
  /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */
}
