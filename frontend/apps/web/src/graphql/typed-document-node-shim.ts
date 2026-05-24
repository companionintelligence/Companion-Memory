/**
 * Shim for @graphql-typed-document-node/core
 *
 * This package only exports TypeScript types, but due to package.json
 * configuration issues, Vite/Rollup fails to resolve it. Since all imports
 * from this package should be `import type` (and thus stripped at compile
 * time), this empty shim satisfies any remaining references.
 */

export {};
