/**
 * Smoke-tests the companion-memory backend without an MCP client.
 *
 * Usage:
 *   COMPANION_MEMORY_URL=... COMPANION_MEMORY_API_KEY=... node dist/smoke-test.js
 */
import { CompanionMemoryClient } from './client.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new CompanionMemoryClient(config);

  process.stdout.write(`→ health check ${config.COMPANION_MEMORY_URL}\n`);
  const health = await client.health();
  process.stdout.write(`  ok service=${health.service} time=${health.time}\n`);

  process.stdout.write('→ remember test memory\n');
  const memory = await client.remember({
    content: 'Smoke test ran successfully',
    tags: ['smoke', 'companion-memory-mcp'],
    source: 'smoke-test',
  });
  process.stdout.write(`  created id=${memory.id}\n`);

  process.stdout.write('→ recall test memory\n');
  const recalled = await client.recall({ query: 'Smoke test', limit: 5 });
  const found = recalled.find((entry) => entry.id === memory.id);
  process.stdout.write(`  matches=${recalled.length} hit=${Boolean(found)}\n`);

  process.stdout.write('→ forget test memory\n');
  const forgotten = await client.forget({ id: memory.id, reason: 'smoke-test cleanup' });
  process.stdout.write(`  forgotten=${forgotten.forgotten} mode=${forgotten.mode}\n`);

  process.stdout.write('smoke test ok\n');
}

main().catch((error) => {
  process.stderr.write(`smoke test failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
