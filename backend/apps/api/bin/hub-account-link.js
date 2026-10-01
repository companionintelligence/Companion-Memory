#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */

/**
 * Show, and repair, which Memory account each Hub person signs in as.
 *
 * The Hub forward-auth bridge links a Hub person to a Memory account as a
 * `ci.federated_identities` row: issuer `urn:ci-hub:<directory>`, subject = the
 * person's Hub public id. A person is linked the first time they arrive, to the
 * account their Hub username names, and keeps that account through any rename
 * afterwards.
 *
 * Before the link existed, the bridge found the account by email alone. A rename
 * moved the person into a new, empty account, and nothing on either side recorded
 * which one they came from. So someone stranded that way is linked to the empty
 * duplicate they have used since. They get their original back only when an
 * operator says which one it is: no database knows, and the person does.
 * See CI-Engineering/architecture/identity/hub-memory-account-link.md, §3.
 *
 *   list                               every Hub link, every unlinked account, and what each holds
 *   move --from <email> --to <email>   re-point the Hub person linked to <from> at <to>
 *   unlink --email <email>             drop <email>'s Hub links; the person's next visit
 *                                      adopts whichever account their Hub username names
 *
 * `move` and `unlink` print what they would do and change nothing without --apply.
 * Nothing here merges or deletes an account: a duplicate keeps whatever it holds.
 *
 * Plain CommonJS on runtime dependencies only, like `dburl.js`, so it runs inside
 * the production image as well as from a checkout:
 *   make hub-account-link ARGS="list"                                  (dev stack)
 *   docker exec <memory api> yarn workspace @ci/be-api hub-account-link list
 */

const dotenv = require('dotenv');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const config = require('config');
const { Client } = require('pg');
const { z } = require('zod');

const HUB_ISSUER_LIKE = 'urn:ci-hub:%';

/**
 * Where a person's memories live, counted to show which account of a pair holds
 * them. Each must be a `ci` table with a `user_id` column; the real-Postgres spec
 * fails when one is renamed or loses it, rather than letting it drop out silently.
 */
const FOOTPRINT_TABLES = [
  'events',
  'communications',
  'content',
  'files',
  'notes',
  'agent_memories',
  'tasks',
  'messages',
];

const USAGE = `Usage:
  hub-account-link list
  hub-account-link move --from <email> --to <email> [--apply]
  hub-account-link unlink --email <email> [--apply]`;

class Refusal extends Error {}

function connectionString() {
  const schema = z.object({
    type: z.literal('postgres'),
    host: z.string(),
    port: z.coerce.number().int(),
    database: z.string(),
    username: z.string(),
    password: z.string(),
    sslmode: z.string().optional().default('disable'),
  });
  const { type, host, port, database, username, password, sslmode } = schema.parse(config.get('db'));

  // Same precedence as dbmate.js and dburl.js: an explicit DATABASE_URL wins.
  return (
    process.env.DATABASE_URL ||
    `${type}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}/${database}?sslmode=${sslmode}`
  );
}

function parseOptions(args) {
  const options = { apply: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--from' || arg === '--to' || arg === '--email') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Refusal(`${arg} needs an email address\n\n${USAGE}`);
      }

      options[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Refusal(`Unknown argument: ${arg}\n\n${USAGE}`);
    }
  }

  return options;
}

function day(value) {
  return value ? new Date(value).toISOString().slice(0, 10) : '—';
}

/** A live account by address: exactly, else the only case-insensitive match. */
async function accountByEmail(client, email) {
  const { rows: exact } = await client.query(
    `SELECT id::text, email, created_at, password_set_at FROM ci.users WHERE email = $1 AND deleted_at IS NULL`,
    [email],
  );
  if (exact.length === 1) {
    return exact[0];
  }

  const { rows: folded } = await client.query(
    `SELECT id::text, email, created_at, password_set_at FROM ci.users
      WHERE lower(email) = lower($1) AND deleted_at IS NULL ORDER BY created_at`,
    [email.trim()],
  );
  if (folded.length === 1) {
    return folded[0];
  }

  if (folded.length > 1) {
    throw new Refusal(
      `${email} matches several accounts in different cases: ${folded.map((row) => row.email).join(', ')}. Name one exactly.`,
    );
  }

  throw new Refusal(`No live account has the address ${email}.`);
}

async function hubLinksOf(client, userId) {
  const { rows } = await client.query(
    `SELECT id::text, issuer, subject, email, bind_method, created_at, last_seen_at
       FROM ci.federated_identities
      WHERE user_id = $1 AND issuer LIKE $2
      ORDER BY created_at`,
    [userId, HUB_ISSUER_LIKE],
  );

  return rows;
}

/** Row counts per account in the footprint tables that exist here. */
async function footprints(client, userIds) {
  const result = new Map(userIds.map((id) => [id, []]));
  if (userIds.length === 0) {
    return result;
  }

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'ci' AND column_name = 'user_id' AND table_name = ANY($1::text[])
      ORDER BY table_name`,
    [FOOTPRINT_TABLES],
  );

  for (const { table_name: table } of tables) {
    // `table` comes from the fixed list above, matched through information_schema.
    const { rows } = await client.query(
      `SELECT user_id::text AS user_id, count(*)::int AS n FROM ci."${table}"
        WHERE user_id::text = ANY($1::text[]) GROUP BY user_id`,
      [userIds],
    );
    for (const row of rows) {
      result.get(row.user_id).push(`${table} ${row.n}`);
    }
  }

  return result;
}

function describeFootprint(parts) {
  return parts.length > 0 ? parts.join(', ') : 'nothing counted';
}

async function list(client) {
  const { rows: links } = await client.query(
    `SELECT f.issuer, f.subject, f.email AS hub_name, f.bind_method, f.created_at, f.last_seen_at,
            u.id::text AS user_id, u.email, u.deleted_at
       FROM ci.federated_identities f
       JOIN ci.users u ON u.id = f.user_id
      WHERE f.issuer LIKE $1
      ORDER BY f.issuer, f.created_at`,
    [HUB_ISSUER_LIKE],
  );
  const { rows: unlinked } = await client.query(
    `SELECT u.id::text AS user_id, u.email, u.created_at, u.password_set_at
       FROM ci.users u
      WHERE u.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ci.federated_identities f WHERE f.user_id = u.id AND f.issuer LIKE $1
        )
      ORDER BY u.created_at`,
    [HUB_ISSUER_LIKE],
  );

  const counts = await footprints(client, [
    ...new Set([...links.map((row) => row.user_id), ...unlinked.map((row) => row.user_id)]),
  ]);

  console.log('Hub people and the Memory account each signs in as:');
  if (links.length === 0) {
    console.log('  (none yet: nobody has opened Memory through a Hub that sends stable ids)');
  }

  for (const row of links) {
    console.log(
      `  ${row.issuer} ${row.subject}\n` +
        `    → ${row.email} (${row.user_id})${row.deleted_at ? ' [DELETED, awaiting purge]' : ''}\n` +
        `      linked ${day(row.created_at)} as ${row.hub_name ?? '?'} (${row.bind_method}), last seen ${day(row.last_seen_at)}\n` +
        `      holds: ${describeFootprint(counts.get(row.user_id))}`,
    );
  }

  console.log('\nAccounts no Hub person is linked to:');
  if (unlinked.length === 0) {
    console.log('  (none)');
  }

  for (const row of unlinked) {
    console.log(
      `  ${row.email} (${row.user_id}), created ${day(row.created_at)}, ` +
        `${row.password_set_at ? 'has a password of its own' : 'no password of its own'}\n` +
        `      holds: ${describeFootprint(counts.get(row.user_id))}`,
    );
  }
}

async function move(client, { from, to, apply }) {
  if (!from || !to) {
    throw new Refusal(`move needs --from and --to\n\n${USAGE}`);
  }

  const source = await accountByEmail(client, from);
  const target = await accountByEmail(client, to);
  if (source.id === target.id) {
    throw new Refusal(`${from} and ${to} are the same account.`);
  }

  const links = await hubLinksOf(client, source.id);
  if (links.length === 0) {
    throw new Refusal(
      `No Hub person is linked to ${source.email}. Have them open Memory through the Hub once, then move them.`,
    );
  }

  for (const link of links) {
    const { rows: held } = await client.query(
      `SELECT subject FROM ci.federated_identities WHERE user_id = $1 AND issuer = $2`,
      [target.id, link.issuer],
    );
    if (held.length > 0) {
      throw new Refusal(
        `${target.email} already belongs to another person of ${link.issuer} (${held[0].subject}). ` +
          `If that is stale, unlink ${target.email} first.`,
      );
    }
  }

  const counts = await footprints(client, [source.id, target.id]);

  console.log(`Hub person(s) linked to ${source.email} (${source.id}):`);
  for (const link of links) {
    console.log(`  ${link.issuer} ${link.subject} (linked ${day(link.created_at)} as ${link.email ?? '?'})`);
  }

  console.log(`  ${source.email} holds: ${describeFootprint(counts.get(source.id))}`);
  console.log(`\nwould sign in as ${target.email} (${target.id}) from their next page load.`);
  console.log(`  ${target.email} holds: ${describeFootprint(counts.get(target.id))}`);
  console.log(`\n${source.email} itself is left as it is: nothing is merged or deleted.`);

  if (!apply) {
    console.log('\nDry run. Add --apply to make the change.');

    return;
  }

  await client.query('BEGIN');
  try {
    // 'email_link': the account was not created for this person. 'sub' must keep
    // meaning exactly that (the password_set_at repair, 20260930164106, relies on it).
    await client.query(
      `UPDATE ci.federated_identities SET user_id = $1, bind_method = 'email_link'
        WHERE user_id = $2 AND issuer LIKE $3`,
      [target.id, source.id, HUB_ISSUER_LIKE],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  console.log(`\nMoved. The Hub person now signs in as ${target.email}.`);
}

async function unlink(client, { email, apply }) {
  if (!email) {
    throw new Refusal(`unlink needs --email\n\n${USAGE}`);
  }

  const account = await accountByEmail(client, email);
  const links = await hubLinksOf(client, account.id);
  if (links.length === 0) {
    console.log(`No Hub person is linked to ${account.email}; nothing to do.`);

    return;
  }

  console.log(`Hub person(s) linked to ${account.email} (${account.id}):`);
  for (const link of links) {
    console.log(
      `  ${link.issuer} ${link.subject} (linked ${day(link.created_at)} as ${link.email ?? '?'}, last seen ${day(link.last_seen_at)})`,
    );
  }

  console.log(
    `\nwould be unlinked. Their next page load adopts the account their Hub username names, ` +
      `or creates one if none does.`,
  );

  if (!apply) {
    console.log('\nDry run. Add --apply to make the change.');

    return;
  }

  await client.query(`DELETE FROM ci.federated_identities WHERE user_id = $1 AND issuer LIKE $2`, [
    account.id,
    HUB_ISSUER_LIKE,
  ]);

  console.log(`\nUnlinked ${links.length} Hub link(s) from ${account.email}.`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const commands = { list, move, unlink };

  if (!command || command === '--help' || command === '-h') {
    console.log(USAGE);

    return 0;
  }

  if (!commands[command]) {
    console.error(`Unknown command: ${command}\n\n${USAGE}`);

    return 2;
  }

  const options = parseOptions(rest);
  const client = new Client({ connectionString: connectionString() });

  await client.connect();
  try {
    await commands[command](client, options);
  } finally {
    await client.end();
  }

  return 0;
}

// The commands take any client with pg's `query(sql, params) → { rows }`, so the
// real-Postgres spec drives them in-process (HubAccountLink.integration.spec.ts).
module.exports = { FOOTPRINT_TABLES, Refusal, list, move, unlink };

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Refusal ? error.message : error);
      process.exit(error instanceof Refusal ? 1 : 2);
    },
  );
}
