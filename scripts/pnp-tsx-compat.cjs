/**
 * Compatibility shim between Yarn PnP (`.pnp.cjs` in Yarn 4.9.1) and `tsx` on
 * Node 22.12+.
 *
 * `tsx`'s CJS resolver hook forwards `{ conditions }` in the 4th `options`
 * argument of `Module._resolveFilename(request, parent, isMain, options)`.
 * Yarn 4.9.1's `.pnp.cjs` only allowlists `paths` and `plugnplay` in `options`
 * and throws `Error: Some options passed to require() aren't supported by PnP
 * yet (conditions)` when `conditions` is present.
 *
 * Preloading this module after `.pnp.cjs` and before `tsx` strips `conditions`
 * before delegating to PnP's `Module._resolveFilename`.
 */
'use strict';

const Module = require('node:module');

if (process.env.NODE_OPTIONS && !process.env.NODE_OPTIONS.includes(__filename)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS} --require ${__filename}`;
}

const pnpResolveFilename = Module._resolveFilename;

Module._resolveFilename = function pnpTsxResolveFilename(request, parent, isMain, options) {
  if (options && typeof options === 'object' && 'conditions' in options) {
    const { conditions: _conditions, ...rest } = options;
    const cleaned = Object.keys(rest).length > 0 ? rest : undefined;
    return pnpResolveFilename.call(this, request, parent, isMain, cleaned);
  }

  return pnpResolveFilename.call(this, request, parent, isMain, options);
};
