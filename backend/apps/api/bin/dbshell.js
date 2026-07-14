/* eslint-disable @typescript-eslint/no-require-imports */

const dotenv = require('dotenv');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const { spawnSync } = require('child_process');

const { Command } = require('commander');
const config = require('config');
const { Client } = require('pg');
const { z } = require('zod');

const schema = z.object({
  type: z.literal('postgres'),
  host: z.string(),
  port: z.coerce.number().int(),
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
  .name('dbshell')
  .description('Open a psql shell using .env and config')
  .option('--no-wait', 'Skip waiting for database availability')
  .allowUnknownOption(true)
  .allowExcessArguments(true);

program.parse(process.argv);

const opts = program.opts();
const forwardArgs = program.args;

(async () => {
  if (opts.wait !== false) {
    await waitForDatabase();
  }

  const result = spawnSync('psql', [DATABASE_URL, ...forwardArgs], {
    stdio: 'inherit',
  });

  // status is null when psql never ran — it is not installed in the API image —
  // or died on a signal. Exiting on it would report success without a shell.
  if (result.error) {
    console.error(`Failed to run psql: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`psql was terminated by signal ${result.signal}.`);
    process.exit(1);
  }

  process.exit(result.status);
})();
