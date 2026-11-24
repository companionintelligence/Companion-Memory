/**
 * xtask — the repo's build automation as a real program, run via `tsx`
 * (mirrors the `xtask` pattern from the `ratatui` project). It holds the
 * Makefile targets that had grown real logic — `build`, `dev`, `test` and
 * `test-db` — whose recipes now just delegate to
 * `yarn tsx scripts/xtask/index.ts <command> ...`.
 *
 * Everything else stays in the Makefile, deliberately. `format`, `lint` and
 * `reset` are sequences of shell commands with no branching, and a program adds
 * only indirection to those. `health` is the toolchain diagnostic, so it must
 * keep working on a checkout too broken to run this program at all.
 *
 * Every thrown Error surfaces here as a single `✗ <message>` line before the
 * process exits nonzero — commands throw rather than calling `process.exit()`
 * themselves, so a command calling another in-process (`dev` -> `build`) still
 * gets to run its own cleanup.
 */
import { main as buildMain } from './commands/build';
import { main as devMain } from './commands/dev';
import { main as testMain } from './commands/test';
import { main as testDbMain } from './commands/test-db';
import { TERMINATION_SIGNALS, ignoreDeadTerminal } from './lib/exec';
import { fail } from '../dev-stack/log';

interface Command {
  main: (argv: string[]) => Promise<void>;
  summary: string;
}

const COMMANDS: Record<string, Command> = {
  build: { main: buildMain, summary: 'Build images (ENV=local|staging|production, GPU=cpu|cuda|rocm)' },
  dev: { main: devMain, summary: 'Run the development environment locally' },
  test: { main: testMain, summary: 'Run the unit tests, both stacks' },
  'test-db': {
    main: testDbMain,
    summary: 'Run the database-backed jest suites against a throwaway Postgres',
  },
};

function printHelp(): void {
  console.log('Usage: xtask <command> [...flags]\n');
  console.log('Commands:');

  for (const [name, { summary }] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(9)} ${summary}`);
  }

  console.log("\nRun 'xtask <command> --help' for a command's own flags.");
}

/**
 * Ctrl-C reaches the whole foreground process group, so the child (docker,
 * overmind, dev-stack) gets its own SIGINT and exits on its own terms. Without
 * a handler here, node's default disposition kills THIS process instantly
 * instead: `spawnSync` never returns, so `build`'s `finally` never runs and it
 * leaks the LICENSE.md copies that block exists to clean up, and `make dev`
 * returns the prompt while the stack is still tearing down.
 *
 * These handlers keep the process alive while spawnSync's child finishes; the
 * child's own nonzero status then propagates through the normal error path.
 * SIGHUP (the terminal closing, an SSH connection dropping) is treated the same
 * as SIGTERM: without a handler it would kill this process outright, before any
 * `finally` — a `test-db` container, `build`'s LICENSE copies — could run.
 */
const onSignal = (): void => {};

for (const signal of TERMINATION_SIGNALS) {
  process.on(signal, onSignal);
}

// A closed terminal answers every write with EIO; without this the process dies at its next status line.
ignoreDeadTerminal();

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h') {
    printHelp();

    return;
  }

  const entry = COMMANDS[command];

  if (!entry) {
    fail(`Unknown command '${command}'. Run 'xtask --help' for the list.`);
    process.exitCode = 1;

    return;
  }

  await entry.main(rest);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
