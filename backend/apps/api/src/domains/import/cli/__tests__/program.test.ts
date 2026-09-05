import type { Command } from 'commander';

import { buildProgram, resolveTarget, DEFAULT_SERVER_URL } from '../program';

import { recordingTerm } from './support/harness';

/**
 * `exitOverride()` on the root command is NOT enough to make a nested group's
 * own `--help` throw instead of calling the real `process.exit` — commander
 * copies `_exitCallback` onto a subcommand once, at the moment `.command()`
 * creates it inside `buildProgram`, which is BEFORE the caller ever gets the
 * chance to call `.exitOverride()` on what it returns. Every command this CLI
 * had before `peers`/`grants`/`asks` was one level deep, so `ci-import --help`
 * (the root's own) was the only `--help` any test ever exercised and this gap
 * stayed latent. Setting the override on every node directly — rather than
 * relying on the one-time inherited copy — is what makes a GROUP's `--help`
 * (`ci-import peers --help`) testable at all instead of killing the whole
 * Jest worker on a stray `process.exit(0)`.
 */
function withDeepExitOverride(command: Command): Command {
  command.exitOverride();

  for (const sub of command.commands) {
    withDeepExitOverride(sub);
  }

  return command;
}

/**
 * The CLI's contract with whoever types `ci-import`: which commands exist, and
 * where it decides to send them.
 */
describe('ci-import program', () => {
  it('lists every command in --help', async () => {
    const term = recordingTerm();
    const program = buildProgram({ term }).exitOverride();

    await expect(program.parseAsync(['node', 'ci-import', '--help'])).rejects.toMatchObject({
      code: 'commander.helpDisplayed',
    });

    const help = term.text();

    for (const command of [
      'datasources',
      'recognize',
      'import',
      'inbox',
      'runs',
      'push',
      'stats',
      'doctor',
      'backfill',
      'peers',
      'grants',
      'asks',
    ]) {
      expect(help).toContain(command);
    }
  });

  it('lists every peers/grants/asks subcommand in each group’s own --help', async () => {
    for (const [group, subcommands] of [
      ['peers', ['list', 'add', 'update', 'revoke']],
      ['grants', ['list', 'show', 'create', 'update', 'revoke', 'history']],
      ['asks', ['inbox', 'outbox', 'show', 'send', 'send-peer', 'approve', 'decline', 'answer', 'history']],
    ] as const) {
      const term = recordingTerm();
      const program = withDeepExitOverride(buildProgram({ term }));

      await expect(program.parseAsync(['node', 'ci-import', group, '--help'])).rejects.toMatchObject({
        code: 'commander.helpDisplayed',
      });

      const help = term.text();

      for (const subcommand of subcommands) {
        expect(help).toContain(subcommand);
      }
    }
  });

  it('tells the reader how to point it at an appliance', async () => {
    const term = recordingTerm();
    const program = buildProgram({ term }).exitOverride();

    await expect(program.parseAsync(['node', 'ci-import', '--help'])).rejects.toBeDefined();

    expect(term.text()).toContain('CI_SERVER_URL');
    expect(term.text()).toContain('CI_API_KEY');
  });

  it('routes a global flag into the command it precedes', async () => {
    const term = recordingTerm();
    const seen: Array<string | undefined> = [];
    const program = buildProgram({
      term,
      makeClient: (options) => {
        seen.push(options.server);

        return { listSources: async () => [] } as never;
      },
    }).exitOverride();

    await program.parseAsync(['node', 'ci-import', '--server', 'http://box:3030', 'datasources']);

    expect(seen).toEqual(['http://box:3030']);
  });

  it('routes a global flag into the GraphQL-backed commands too', async () => {
    const term = recordingTerm();
    const seen: Array<string | undefined> = [];
    const program = buildProgram({
      term,
      makeClient: () => ({}) as never,
      makeGraphQLClient: (options) => {
        seen.push(options.server);

        return { myPeerLinks: async () => [] } as never;
      },
    }).exitOverride();

    await program.parseAsync(['node', 'ci-import', '--server', 'http://box:3030', 'peers', 'list']);

    expect(seen).toEqual(['http://box:3030']);
  });

  describe('resolveTarget', () => {
    it('prefers the flag, then the environment, then the default', () => {
      expect(resolveTarget({ server: 'http://flag' }, { CI_SERVER_URL: 'http://env' }).baseUrl).toBe(
        'http://flag',
      );
      expect(resolveTarget({}, { CI_SERVER_URL: 'http://env' }).baseUrl).toBe('http://env');
      expect(resolveTarget({}, {}).baseUrl).toBe(DEFAULT_SERVER_URL);
    });

    it('accepts either spelling of the api key env var', () => {
      expect(resolveTarget({}, { CI_API_KEY: 'a' }).apiKey).toBe('a');
      expect(resolveTarget({}, { CI_SERVER_API_KEY: 'b' }).apiKey).toBe('b');
      expect(resolveTarget({}, { CI_API_KEY: 'a', CI_SERVER_API_KEY: 'b' }).apiKey).toBe('a');
    });

    it('never invents a key — an empty credential must not become an opaque 401', () => {
      expect(resolveTarget({}, {}).apiKey).toBeNull();
    });
  });
});
