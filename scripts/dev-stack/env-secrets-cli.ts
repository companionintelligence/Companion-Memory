/**
 * env-secrets-cli: the Makefile's entry into ./env-secrets.
 *
 *   yarn tsx scripts/dev-stack/env-secrets-cli.ts mint [file]
 *     Replace every `replace-me-...` value in <file> (default `.env`) with fresh
 *     random hex. `make init` runs it on the `.env` it has just copied from
 *     `.env.default`. On an existing stack's `.env` it signs everyone out of that
 *     stack and changes its object-store keys, so run it there only on a stack
 *     you can recreate.
 *
 *   yarn tsx scripts/dev-stack/env-secrets-cli.ts check [file]
 *     Exit 1, naming the keys, while <file> still holds a placeholder, leaves out
 *     a secret the API would replace with its own variable name, or does not
 *     exist. `make tunnel` runs it before publishing the stack.
 */
import fs from 'node:fs';

import { mintPlaceholderSecrets, placeholderKeys, unsetSecretKeys } from './env-secrets';
import { fail, ok } from './log';

function mint(file: string): number {
  if (!fs.existsSync(file)) {
    fail(`${file} does not exist`);

    return 1;
  }

  const { text, minted } = mintPlaceholderSecrets(fs.readFileSync(file, 'utf8'));

  fs.writeFileSync(file, text);

  if (minted.length > 0) {
    ok(`Generated ${minted.length} secrets in ${file} (${minted.join(', ')})`);
  } else {
    ok(`No placeholder secrets in ${file}`);
  }

  return 0;
}

function check(file: string): number {
  if (!fs.existsSync(file)) {
    fail(
      `${file} does not exist, so the API would sign tokens with the literal key names in ` +
        'backend/apps/api/config/default.json. Run `make init` first.',
    );

    return 1;
  }

  const text = fs.readFileSync(file, 'utf8');
  const keys = placeholderKeys(text);
  const unset = unsetSecretKeys(text);

  if (keys.length > 0) {
    fail(
      `${file} still holds the replace-me- placeholders committed in .env.default for ${keys.join(', ')}. ` +
        'Anyone who can read the repo could sign in to or read from a stack published with them. ' +
        `Replace them with \`yarn tsx scripts/dev-stack/env-secrets-cli.ts mint ${file}\`, then restart ` +
        'the stack (that signs everyone out of it and changes its object-store keys).',
    );
  }

  if (unset.length > 0) {
    fail(
      `${file} does not set ${unset.join(', ')}, so the API uses each variable's own name, ` +
        'committed in backend/apps/api/config/default.json, as its value. Copy those lines from ' +
        `.env.default, run \`yarn tsx scripts/dev-stack/env-secrets-cli.ts mint ${file}\`, then restart the stack.`,
    );
  }

  return keys.length > 0 || unset.length > 0 ? 1 : 0;
}

const [command, file = '.env'] = process.argv.slice(2);

if (command === 'mint') {
  process.exit(mint(file));
} else if (command === 'check') {
  process.exit(check(file));
} else {
  fail('usage: env-secrets-cli.ts mint|check [file]');
  process.exit(2);
}
