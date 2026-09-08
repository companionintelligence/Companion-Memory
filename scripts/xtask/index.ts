/**
 * xtask — the repo's build/dev automation as a real program, run via `tsx`
 * (mirrors the `xtask` pattern from the `ratatui` project). Ports `build`,
 * `dev`, `test`, `lint`, `format` and `reset` out of the root Makefile, whose
 * six matching targets now just delegate to
 * `yarn tsx scripts/xtask/index.ts <command> ...`. Every other Makefile target
 * is untouched — including `help`, and including `health`, which stays shell on
 * purpose so it can still diagnose a toolchain too broken to run this program.
 *
 * Every thrown Error surfaces here as a single `✗ <message>` line before the
 * process exits nonzero — commands throw rather than calling `process.exit()`
 * themselves, so a command calling another in-process (`dev` -> `build`) still
 * gets to run its own cleanup.
 */
import { main as buildMain } from './commands/build';
import { main as devMain } from './commands/dev';
import { main as formatMain } from './commands/format';
import { main as lintMain } from './commands/lint';
import { main as resetMain } from './commands/reset';
import { main as testMain } from './commands/test';
import { fail } from '../dev-stack/log';

interface Command {
  main: (argv: string[]) => Promise<void>;
  summary: string;
}

const COMMANDS: Record<string, Command> = {
  build: { main: buildMain, summary: 'Build images (ENV=local|staging|production, GPU=cpu|cuda|rocm)' },
  dev: { main: devMain, summary: 'Run the development environment locally' },
  test: { main: testMain, summary: 'Run the unit tests, both stacks' },
  lint: { main: lintMain, summary: 'Check the source for lint and formatting errors, both stacks' },
  format: { main: formatMain, summary: 'Format the source, both stacks' },
  reset: { main: resetMain, summary: 'Reset the local development environment' },
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
 */
const onSignal = (): void => {};

process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

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
