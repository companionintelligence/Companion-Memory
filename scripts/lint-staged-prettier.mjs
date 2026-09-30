// The Prettier task for the nested lint-staged configs
// (backend/apps/api/.lintstagedrc.mjs, frontend/apps/web/.lintstagedrc.mjs).
//
// lint-staged gives each staged file to the config NEAREST it, so a nested
// config replaces the root `.lintstagedrc` — and its `prettier --write` — for
// its whole subtree. It also runs that config's tasks from the config's own
// directory, and Prettier looks for `.gitignore` / `.prettierignore` only in
// the cwd. Run from `frontend/apps/web` without these flags, Prettier formats
// the generated `src/graphql/graphql.ts` the root ignore file excludes, and
// `make graphql && git status --porcelain` then fails on the diff. Passing the
// root files explicitly makes a commit format exactly what the root
// `yarn format` would.
//
// `-T` runs the root workspace's Prettier: neither app workspace depends on it.
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const prettierWrite =
  `yarn run -T prettier --write` +
  ` --ignore-path "${ROOT}.gitignore" --ignore-path "${ROOT}.prettierignore"`;
