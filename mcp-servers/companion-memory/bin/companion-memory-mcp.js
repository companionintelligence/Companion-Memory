#!/usr/bin/env node
import('../dist/index.js').catch((error) => {
  process.stderr.write(`companion-memory: failed to load entry point: ${error?.message ?? error}\n`);
  process.exit(1);
});
