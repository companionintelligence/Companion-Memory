/**
 * sidecar-secret — backfill SIDECAR_AUTH_SECRET into a `.env` that predates it.
 *
 * `.env` is copied from `.env.default` once and never re-synced, so a key added
 * to the template later only reaches fresh checkouts. This one the stack cannot
 * boot without: the HBPE and Summary entrypoints exit 1 when it is empty, so
 * `compose up --wait` fails, and the host API (run by overmind) would present a
 * different bearer than the containers expect even if they did start.
 *
 * `make init` does the same append for `make dev`; this covers
 * `yarn tsx scripts/dev-stack/index.ts up`, which never runs `make init`.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const KEY = 'SIDECAR_AUTH_SECRET';

/**
 * Mint SIDECAR_AUTH_SECRET into `env` (and, when `envFile` exists, persist it
 * there) if nothing has set it. A no-op whenever the key is already present —
 * from `.env`, which dotenv has loaded by now, or from the shell — so an
 * explicit value is never replaced. Returns whether it minted one.
 *
 * It sets `env` rather than only writing the file because compose and overmind
 * both inherit `process.env`: that is what makes the API and the sidecars agree
 * on this very run. Persisting keeps them agreeing across restarts. A missing
 * `.env` is never created here — `make init` copies the template only when
 * `.env` does not exist, and a file holding just this key would stop it.
 */
export function ensureSidecarAuthSecret(envFile: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env[KEY] !== undefined) {
    return false;
  }

  const secret = crypto.randomBytes(32).toString('hex');

  if (fs.existsSync(envFile)) {
    // Leading newline: a `.env` that does not end in one would otherwise glue
    // this key onto its last value.
    fs.appendFileSync(
      envFile,
      `\n# Bearer the API presents to the HBPE/Summary sidecars; they refuse requests without it.\n${KEY}=${secret}\n`,
    );
  }

  env[KEY] = secret;

  return true;
}
