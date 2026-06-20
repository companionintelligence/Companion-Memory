/**
 * oauth — point the static OAuth host at the running stack in this worktree.
 *
 * The provider always redirects to one fixed, registered host (the host of
 * OAUTH_CALLBACK_URL in .env), so only one stack can answer it at a time. Run
 * `make oauth` from whichever worktree you want to test OAuth in: it makes that
 * static host 307-redirect to this stack's <key>.localhost and replaces any
 * prior claim. `make oauth-down` releases it. The supervisor also releases it
 * automatically when the owning stack tears down.
 *
 * The claim itself lives in ./caddy alongside the rest of the admin client, so
 * this file is just argument parsing.
 */
import path from 'node:path';

import dotenv from 'dotenv';

import { CaddyClient } from './caddy';
import { fail } from './log';

const ROOT = process.cwd();

dotenv.config({
  path: path.join(ROOT, '.env'),
  quiet: true,
});

function resolveKey(argv: string[]): string {
  const i = argv.indexOf('--key');
  const raw = i !== -1 ? argv[i + 1] : process.env.PROJECT_NAME;

  if (!raw) {
    throw new Error('pass --key <name> (or set PROJECT_NAME)');
  }

  return raw.toLowerCase().replace(/[/.]/g, '-');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'up';

  const caddy = new CaddyClient();

  if (command === 'down') {
    await caddy.releaseOauth();
  } else {
    await caddy.claimOauth(resolveKey(argv));
  }
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
