/* eslint-disable @typescript-eslint/no-require-imports */

const dotenv = require('dotenv');

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const config = require('config');
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

// Honor an explicit DATABASE_URL (the dev-stack supervisor sets one) the same
// way dbmate.js does, so this prints exactly what the tooling connects with;
// otherwise build it from node-config/.env. `make dburl` exports the running
// stack's discovered DATABASE_PORT, so this resolves to THIS worktree's DB.
const DATABASE_URL =
  process.env.DATABASE_URL ||
  `${type}://${username}:${password}@${host}:${port}/${database}?sslmode=${sslmode}`;

// Individual fields for clients that take them separately (e.g. DataGrip's
// host/port/user/password form), plus the full URL.
const fields = [
  ['Host', host],
  ['Port', port],
  ['Database', database],
  ['User', username],
  ['Password', password],
  ['SSL mode', sslmode],
];
const labelWidth = Math.max(...fields.map(([label]) => label.length));

for (const [label, value] of fields) {
  console.log(`${`${label}:`.padEnd(labelWidth + 1)}  ${value}`);
}

console.log('');

console.log(DATABASE_URL);
