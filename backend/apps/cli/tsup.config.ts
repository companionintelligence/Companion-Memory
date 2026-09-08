import { defineConfig } from 'tsup';

/**
 * One file, no runtime resolution.
 *
 * `commander` is bundled in rather than left external so `dist/ci.cjs` runs
 * from anywhere `node` does — a vendored copy, a container with no npm, a
 * `curl`-and-run. It stays declared as a dependency because the source really
 * does import it and `yarn dev` resolves it for real; inlining is the
 * bundler's optimisation, not a change to what this package needs.
 *
 * CJS rather than ESM because the entry point uses `__dirname` to find its own
 * manifest (see `resolveVersion`) and because a CLI gains nothing from ESM that
 * would pay for `import.meta.url` shims. `noExternal` is spelled out rather
 * than left to the default: tsup externalises everything in `dependencies`
 * unless told otherwise, which would put the one dependency back in
 * node_modules and quietly undo the single-file property this package is for.
 */
export default defineConfig({
  entry: { ci: 'src/main.ts' },
  format: ['cjs'],
  // `.cjs` rather than the `.js` tsup would emit for a package with no
  // `"type"` field. Same semantics today, but the extension states them, so a
  // later `"type": "module"` in package.json cannot silently make node parse
  // the bundle as ESM and fail on its first `require`.
  outExtension: () => ({ js: '.cjs' }),
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  // Types are checked by `yarn typecheck`; a .d.ts for a bin is dead weight.
  dts: false,
  sourcemap: false,
  splitting: false,
  noExternal: ['commander'],
  // Off because this is already CJS: the shims exist to give an ESM bundle a
  // `__dirname`, and asking for them here would replace a working one.
  shims: false,
});
