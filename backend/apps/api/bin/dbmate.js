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

const schema = z.object({
  type: z.literal('postgres'),
  host: z.string(),
  port: z.number(),
  database: z.string(),
  username: z.string(),
  password: z.string(),
  sslmode: z.string().optional().default('disable'),
});

let parsedDb;

try {
  parsedDb = schema.parse(config.get('db'));
} catch (err) {
  console.error('Invalid DB config:', err.errors);
  process.exit(1);
}

const { type, host, port, database, username, password, sslmode } = parsedDb;
const DATABASE_URL = `${type}://${username}:${password}@${host}:${port}/${database}?sslmode=${sslmode}`;

const program = new Command();

program
  .name('dbmate')
  .description('Wrapper for dbmate with .env and config support')
  .option('--execute-file <file>', 'Execute raw SQL from a file')
  .allowUnknownOption(true)
  .allowExcessArguments(true);

program.parse(process.argv);

const opts = program.opts();
const forwardArgs = program.args;

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

  (async () => {
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
  })();
} else {
  const result = spawnSync('dbmate', forwardArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      DATABASE_URL,
      DBMATE_MIGRATIONS_DIR: './db/postgres/migrations',
    },
  });

  process.exit(result.status);
}
