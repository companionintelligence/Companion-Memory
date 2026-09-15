import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * No controller may bake `api/` into its own mount path.
 *
 * The gateway proxies the API under `location /api/` and strips the prefix
 * before forwarding (`rewrite ^/api/(.*)$ /$1 break`, infrastructure/gateway/
 * nginx.conf). The app sets no `setGlobalPrefix`, so controller paths are
 * literal. A controller mounted `api/foo` therefore never matches: a client
 * asking for `/api/foo` reaches the backend as `/foo`, and the only URL that
 * would work is the absurd `/api/api/foo`.
 *
 * This is not hypothetical. Five controllers shipped this way — the intent
 * catalog and executor (both harnesses swallowed the 404 silently, see
 * CI-Server#1684), the pending-action queue and the tool-invocation ledger
 * (which is why neither ever grew a frontend), plus privacy and model-routing.
 * Each was individually plausible; the class of bug is what needed a test.
 *
 * A source scan rather than a Nest bootstrap: the failure is a typo in a
 * decorator, it costs nothing to catch here, and this runs without a database.
 */
const CONTROLLER_DECORATOR = /@Controller\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;

function offendingMounts(): string[] {
  const root = join(__dirname, '..', '..');

  const files = execFileSync('grep', ['-rl', '--include=*.ts', '@Controller(', root], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);

  const offenders: string[] = [];

  for (const file of files) {
    const source = execFileSync('cat', [file], { encoding: 'utf8' });

    for (const match of source.matchAll(CONTROLLER_DECORATOR)) {
      const paths = match[1].match(/['"]([^'"]*)['"]/g) ?? [];

      for (const quoted of paths) {
        const path = quoted.slice(1, -1);

        if (path === 'api' || path.startsWith('api/')) {
          offenders.push(`${file.replace(root, '')}: '${path}'`);
        }
      }
    }
  }

  return offenders;
}

describe('controller mounts vs the gateway /api strip', () => {
  it('no controller mounts under api/ — the gateway strips it, so such a route is unreachable', () => {
    expect(offendingMounts()).toEqual([]);
  });
});
