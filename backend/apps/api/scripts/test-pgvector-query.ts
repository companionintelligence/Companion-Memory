import knex from 'knex';
import { fromSql, toSql } from 'pgvector';

// Update with your actual config or import from your config files
const db = knex({
  client: 'pg',
  connection: {
    host: process.env.PGHOST || '127.0.0.1',
    user: process.env.PGUSER || 'companion_intel',
    password: process.env.PGPASSWORD || 'comp4nion_1ntel_ftw!',
    database: process.env.PGDATABASE || 'companion_intel',
    port: Number(process.env.PGPORT) || 5432,
  },
});

async function main() {
  // Example: Find people whose embedding is close to a given vector
  const queryEmbedding = [0.1, 0.2, 0.3, /* ... fill to 1536 dims ... */];
  // For demo, use a short vector and cast in SQL for test
  const personResults = await db.raw(
    `SELECT id, first_name, embedding <-> ? AS distance FROM person WHERE embedding IS NOT NULL ORDER BY embedding <-> ? LIMIT 5`,
    [toSql(queryEmbedding), toSql(queryEmbedding)]
  );
  console.log('Nearest people:', personResults.rows);

  // Example: Find events whose embedding is close to a given vector
  const eventResults = await db.raw(
    `SELECT id, type, embedding <-> ? AS distance FROM event WHERE embedding IS NOT NULL ORDER BY embedding <-> ? LIMIT 5`,
    [toSql(queryEmbedding), toSql(queryEmbedding)]
  );
  console.log('Nearest events:', eventResults.rows);

  await db.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
