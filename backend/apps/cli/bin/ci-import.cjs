#!/usr/bin/env node
/**
 * The deprecated `ci-import` name.
 *
 * The binary was called `ci-import` while it was the import domain's command
 * line and nothing else. It is now the appliance's — `stats`, `doctor`,
 * `backfill`, `peers`, `grants` and `asks` have nothing to do with importing —
 * so the name is `ci`, and this shim keeps every script, runbook and shell
 * history that already says `ci-import` working.
 *
 * The notice goes to STDERR, which is the whole reason this is worth doing at
 * all: `ci-import runs --json | jq` must keep parsing. Anything printed to
 * stdout here would be a breaking change dressed up as a courtesy.
 *
 * Plain CommonJS with no dependencies, and not part of the bundle: it has to
 * work from `bin/` in the installed package before anything else is resolved.
 * Requiring the bundle runs it — `dist/ci.cjs` calls its own `main()` at module
 * scope — so the program below is the same program, with the same argv, the
 * same exit codes and the same output.
 */
process.stderr.write(
  '`ci-import` is deprecated and will be removed in a future release: the command is now `ci`.\n' +
    'Every subcommand, flag and exit code is unchanged — `ci-import doctor` is `ci doctor`.\n',
);

require('../dist/ci.cjs');
