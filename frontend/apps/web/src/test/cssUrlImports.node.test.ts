import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * A stylesheet imported from a package with `?url` stops the production build
 * unless that package is unplugged. Vite 8 rewrites the import into a
 * `?transform-only` one that Rolldown fails to load from inside a Yarn zip
 * (UNLOADABLE_DEPENDENCY, #3403). `unplugged: true` under the root
 * package.json's `dependenciesMeta` extracts the package so the file can be read.
 *
 * Nothing else notices a missing entry: no PR check builds the web app, so the
 * first sign used to be a failed release build.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const rootManifest = JSON.parse(
  readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8'),
) as {
  dependenciesMeta?: Record<string, { unplugged?: boolean }>;
};

const CSS_URL_IMPORT = /from\s+['"]([^'"./][^'"]*\.css)\?url['"]/g;

function packageOf(specifier: string): string {
  const parts = specifier.split('/');

  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function cssUrlImports(): Array<{ file: string; pkg: string }> {
  const found: Array<{ file: string; pkg: string }> = [];

  for (const file of readdirSync(SRC, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(file)) {
      continue;
    }

    for (const [, specifier] of readFileSync(join(SRC, file), 'utf8').matchAll(CSS_URL_IMPORT)) {
      // `@/` is this app's own source and `@ci/` its workspaces: both are plain files on disk.
      if (!specifier.startsWith('@/') && !specifier.startsWith('@ci/')) {
        found.push({ file, pkg: packageOf(specifier) });
      }
    }
  }

  return found;
}

function isUnplugged(pkg: string): boolean {
  // `yarn unplug` writes `name@version` keys; a bare name covers every version.
  return Object.entries(rootManifest.dependenciesMeta ?? {}).some(
    ([key, meta]) => (key === pkg || key.startsWith(`${pkg}@`)) && meta.unplugged === true,
  );
}

describe('stylesheets imported with ?url', () => {
  const imports = cssUrlImports();

  it('finds the TimelineJS stylesheet, so the scan still sees imports', () => {
    expect(imports.map(({ pkg }) => pkg)).toContain('@knight-lab/timelinejs');
  });

  it.each(imports)('$pkg ($file) is unplugged in the root package.json', ({ pkg }) => {
    expect(isUnplugged(pkg)).toBe(true);
  });
});
