/**
 * xtask — the repo's build/dev automation as a real program, run via `tsx`
 * (mirrors the `xtask` pattern from the `ratatui` project). Ports `build`,
 * `dev`, `test`, `lint`, `format`, `health` and `reset` out of the root
 * Makefile, whose 7 matching targets now just delegate to
 * `yarn tsx scripts/xtask/index.ts <command> ...`. Every other Makefile
 * target — `make help` included — is untouched.
 *
 * Every thrown Error surfaces here as a single `✗ <message>` line before the
 * process exits nonzero — commands throw rather than calling
 * `process.exit()` themselves so that `dev` calling `build`/`health`
 * in-process still gets to run its own cleanup.
 */
import { main as buildMain } from './commands/build';
import { main as devMain } from './commands/dev';
import { main as formatMain } from './commands/format';
import { main as healthMain } from './commands/health';
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
  health: { main: healthMain, summary: 'Check the repository for prerequisites' },
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
