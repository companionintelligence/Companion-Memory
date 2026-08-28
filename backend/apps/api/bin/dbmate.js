/* eslint-disable @typescript-eslint/no-require-imports */

const dotenv = require('dotenv');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const { spawnSync } = require('child_process');
const { readFileSync } = require('fs');
const path = require('path');

const { confirm } = require('@inquirer/prompts');
const { Command } = require('commander');
const config = require('config');
const { Client } = require('pg');
const { z } = require('zod');

const UNSAFE_OPERATIONS = new Set(['drop_all_pg_data.sql']);

// dbmate subcommands that only touch the filesystem; creating a migration
// must not require a running database.
const OFFLINE_COMMANDS = new Set(['new']);

const schema = z.object({
  type: z.literal('postgres'),
  host: z.string(),
  port: z.coerce.number().int(),
  database: z.string(),
  username: z.string(),
  password: z.string(),
  sslmode: z.string().optional().default('disable'),
});

function databaseUrlFromConfig() {
  let parsedDb;

  try {
    parsedDb = schema.parse(config.get('db'));
  } catch (err) {
    console.error('Invalid DB config:', err.errors);
    process.exit(1);
  }

  const { type, host, port, database, username, password, sslmode } = parsedDb;

  return `${type}://${username}:${password}@${host}:${port}/${database}?sslmode=${sslmode}`;
}

const DATABASE_URL = process.env.DATABASE_URL || databaseUrlFromConfig();

/**
 * Compose project this checkout's stack runs under, mirroring
 * scripts/dev-stack/key.ts: the repo stem (the directory holding the common git
 * dir) plus a linked worktree's own directory name.
 *
 * Derived from git rather than read from the environment alone because the
 * environment is exactly what is missing in the case this guards: a bare
 * `yarn workspace @ci/be-api migrate`, run without `make`, has no
 * COMPOSE_PROJECT_NAME and resolves the port from .env's hard-coded 5432.
 * Returns null where there is no git (the production image), which skips the
 * check — nothing stamps a stack key there either.
 */
function currentStackKey() {
  const sanitize = (value) => value.toLowerCase().replace(/[/.]/g, '-');
  const fromEnv = process.env.COMPOSE_PROJECT_NAME || process.env.PROJECT_NAME;

  if (fromEnv) {
    return sanitize(fromEnv);
  }

  const git = (...args) => spawnSync('git', args, { encoding: 'utf8' }).stdout?.trim() ?? '';
  const common = git('rev-parse', '--git-common-dir');
  const top = git('rev-parse', '--show-toplevel');

  if (!common || !top) {
    return null;
  }

  const repo = sanitize(path.basename(path.dirname(path.resolve(process.cwd(), common))));
  const worktree = sanitize(path.basename(top));

  return worktree === repo ? repo : `${repo}-${worktree}`;
}

/**
 * Refuse to write to a database another worktree's stack owns.
 *
 * Each worktree has its own compose project and its own db-data volume, but the
 * Postgres host port is dynamic while .env pins DATABASE_PORT=5432 — so any
 * invocation that does not go through `make` (which discovers the real port off
 * the running container) silently targets whichever stack currently holds 5432.
 * Applying this branch's migrations to that stack leaves it on a schema no
 * branch describes, and dbmate cannot undo it: the versions are recorded, so
 * the next `migrate` is a no-op and the app queries tables that do not exist.
 *
 * The stamp is written by scripts/dev-stack (see stampStackIdentity there). An
 * absent stamp means staging, production, or a hand-rolled `docker compose up`,
 * where per-worktree isolation is not a concept — those pass.
 */
async function assertStackOwnership() {
  const client = new Client(DATABASE_URL);

  let owner;

  // An unreachable database is not this guard's verdict to give — with
  // --no-wait the command is expected to fail on its own terms, and swallowing
  // that here would replace dbmate's error with a connection stack trace.
  try {
    await client.connect();
  } catch {
    return;
  }

  try {
    const result = await client.query("SELECT current_setting('ci.stack_key', true) AS stack_key");

    owner = result.rows[0]?.stack_key || null;
  } finally {
    await client.end();
  }

  const expected = currentStackKey();

  if (owner == null || expected == null || owner === expected) {
    return;
  }

  const { port } = new URL(DATABASE_URL);

  console.error(
    `\nRefusing to run: ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')} belongs to another stack.\n`,
  );
  console.error(`  database owned by: ${owner}`);
  console.error(`  this checkout is:  ${expected}`);
  console.error(`  port reached:      ${port}\n`);
  console.error("  .env pins DATABASE_PORT=5432, but each worktree's stack publishes Postgres on");
  console.error('  its own host port. Run DB commands through make, which reads the real port off');
  console.error("  this project's running container:\n");
  console.error('    make migrate        # or make dev, seed, dbshell, dburl\n');
  console.error('  If this worktree has no stack yet, start one with `make dev`.\n');

  process.exit(1);
}

async function waitForDatabase(maxRetries = 30, retryDelay = 1000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const client = new Client(DATABASE_URL);

      await client.connect();
      await client.query('SELECT 1');
      await client.end();

      return;
    } catch (err) {
      if (attempt === maxRetries) {
        console.error(`Database not available after ${maxRetries} attempts:`, err.message);
        process.exit(1);
      }

      console.log(`Database not ready (attempt ${attempt}/${maxRetries}), retrying in ${retryDelay}ms...`);

      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }
  }
}

const program = new Command();

program
  .name('dbmate')
  .description('Wrapper for dbmate with .env and config support')
  .option('--execute-file <file>', 'Execute raw SQL from a file')
  .option('--no-wait', 'Skip waiting for database availability')
  .allowUnknownOption(true)
  .allowExcessArguments(true);

program.parse(process.argv);

const opts = program.opts();
const forwardArgs = program.args;

(async () => {
  if (opts.wait !== false && !OFFLINE_COMMANDS.has(forwardArgs[0])) {
    await waitForDatabase();
  }

  if (!OFFLINE_COMMANDS.has(forwardArgs[0])) {
    await assertStackOwnership();
  }

  if (opts.executeFile) {
    const filePath = path.resolve(opts.executeFile);

    let sql;

    try {
      sql = readFileSync(filePath, 'utf8');
    } catch {
      console.error(`Failed to read SQL file: ${opts.executeFile}`);
      process.exit(1);
    }

    let client;

    try {
      client = new Client(DATABASE_URL);
    } catch {
      console.error(`Failed to connect to SQL database`);
      process.exit(1);
    }

    if (UNSAFE_OPERATIONS.has(path.basename(filePath)) || /(drop|delete)/i.test(sql)) {
      console.log('⚠️ WARNING ⚠️\n');
      console.log('This command will execute the following SQL:\n');
      console.log(sql);

      const ok = await confirm({
        message: 'Are you sure you would like to proceed? This cannot be undone.',
        default: false,
      });

      if (!ok) {
        console.log('\nAborted.');
        process.exit(0);
      }
    }

    try {
      await client.connect();
      await client.query(sql);
      console.log('\nSQL script executed successfully.');
    } catch (err) {
      console.error('Failed to run SQL script:', err);
      process.exit(1);
    } finally {
      await client.end();
    }

    process.exit(0);
  } else {
    const result = spawnSync('dbmate', forwardArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL,
        DBMATE_MIGRATIONS_DIR: './db/postgres/migrations',
        DBMATE_SCHEMA_FILE: './db/postgres/schema.sql',
      },
    });

    // status is null when the child never ran (dbmate missing, wrong arch) or
    // died on a signal (OOM kill mid-migration). Exiting on it would report
    // success: compose treats migrate-database as completed and boots the api
    // against an unmigrated database.
    if (result.error) {
      console.error(`Failed to run dbmate: ${result.error.message}`);
      process.exit(1);
    }

    if (result.signal) {
      console.error(`dbmate was terminated by signal ${result.signal}.`);
      process.exit(1);
    }

    process.exit(result.status);
  }
})();
