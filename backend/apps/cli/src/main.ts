#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { CommanderError } from 'commander';

import { ApiError, UnreachableError } from './client';
import { CliError } from './context';
import { processTerm } from './output';
import { buildProgram } from './program';
import { WaitTimeoutError, WaitUnreachableError } from './wait';

/**
 * The `ci` entry point.
 *
 * Everything interesting is in {@link buildProgram} and the commands; this file
 * exists to own the two things a library must not: which stream the words go to,
 * and what the process exits with.
 *
 * Exit codes: 0 success, 2 for a failure the caller can fix (a bad path, a
 * missing key, an unreachable server, a stage name that does not exist), 1 for
 * one we cannot — an unexpected exception, which also gets its stack. The split
 * matters in a script: 2 means "you asked for something impossible", 1 means
 * "look at the appliance".
 */
async function main(): Promise<number> {
  const term = processTerm();
  const program = buildProgram({ term, version: resolveVersion() });

  try {
    // Commander would otherwise call process.exit itself, which skips the
    // error handling below and makes the whole program untestable.
    await program.exitOverride().parseAsync(process.argv);

    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // `--help` and `--version` arrive here as "errors" having already printed
      // what they were asked for. They are successes.
      return err.code === 'commander.helpDisplayed' || err.code === 'commander.version' ? 0 : err.exitCode;
    }

    if (err instanceof CliError) {
      term.err(err.message);

      return err.exitCode;
    }

    if (
      err instanceof UnreachableError ||
      err instanceof WaitTimeoutError ||
      err instanceof WaitUnreachableError
    ) {
      term.err(err.message);

      return 2;
    }

    if (err instanceof ApiError) {
      term.err(`${err.path} — ${err.message}`);

      return err.status >= 500 ? 1 : 2;
    }

    term.err(`unexpected: ${(err as Error).stack ?? String(err)}`);

    return 1;
  }
}

/**
 * This package's version, found by walking up from wherever the file was
 * installed.
 *
 * A walk rather than a fixed relative path because the depth differs by one
 * between the bundle (`<pkg>/dist/ci.cjs`) and running the source directly
 * (`<pkg>/src/main.ts`), and a version string is not worth a build-time define
 * that then has to be kept working in both. It matched `@ci/be-api` when the
 * CLI shipped from inside the server; that name would now find the API's
 * manifest in a monorepo checkout and nothing at all after `npm i -g`.
 *
 * Absent, the CLI still works — it simply does not know what it is called.
 */
function resolveVersion(): string {
  let dir = __dirname;

  // Four rather than eight: the manifest is one level up from either entry
  // point, and a deeper walk in a monorepo only finds someone else's.
  for (let up = 0; up < 4; up += 1) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        name?: string;
        version?: string;
      };

      if (parsed.name === '@ci/cli') {
        return parsed.version ?? '0.0.0';
      }
    } catch {
      // Not here; keep climbing.
    }

    const parent = path.dirname(dir);

    if (parent === dir) {
      break;
    }

    dir = parent;
  }

  return '0.0.0';
}

void main().then((code) => {
  process.exitCode = code;
});
