/**
 * A model of the docker daemon for unit tests: a list of containers, and a CLI
 * that answers `run`, `port`, `rm` and `ps` from it — `ps` honouring the
 * `--filter name=` (a regular expression) and `--filter label=` arguments the
 * way the real one does, so a test that gets a filter wrong is caught by the
 * daemon and not by the assertion. Every call is recorded, with the options it
 * carried, so a test can assert that each one had a timeout.
 *
 * Test support only; nothing in the command imports it.
 */
import { LABEL_KEY, LABEL_VALUE } from './testDb';
import type { DockerFn, DockerOptions, DockerResult } from './docker';

export const ok = (stdout = ''): DockerResult => ({ status: 0, stdout, stderr: '' });
export const failed = (stderr: string): DockerResult => ({ status: 1, stdout: '', stderr });
/** What `docker()` returns for a call that hit its timeout. */
export const timedOut = (sub: string): DockerResult => ({
  status: null,
  stdout: '',
  stderr: `docker ${sub} timed out after 1 ms`,
});

export interface FakeContainer {
  id: string;
  name: string;
  labels: Record<string, string>;
}

export interface Call {
  args: string[];
  opts: DockerOptions | undefined;
}

export interface FakeDaemonOptions {
  containers?: FakeContainer[];
  /** Overrides for a subcommand: return a result to answer it yourself, or undefined to fall through to the model. */
  override?: Partial<Record<string, (args: string[], daemon: FakeDaemon) => DockerResult | undefined>>;
  /** Make `ps` ignore its `--filter` arguments, like a daemon (or a bug) that returns everything. */
  psIgnoresFilters?: boolean;
}

export class FakeDaemon {
  readonly containers: FakeContainer[];

  readonly calls: Call[] = [];

  readonly run: DockerFn;

  constructor(private readonly options: FakeDaemonOptions = {}) {
    this.containers = [...(options.containers ?? [])];
    this.run = (args, opts) => {
      this.calls.push({ args, opts });

      return options.override?.[args[0]]?.(args, this) ?? this.answer(args);
    };
  }

  sub(cmd: string): string[][] {
    return this.calls.filter((c) => c.args[0] === cmd).map((c) => c.args);
  }

  get subcommands(): string[] {
    return this.calls.map((c) => c.args[0]);
  }

  private answer(args: string[]): DockerResult {
    switch (args[0]) {
      case 'rm': {
        const target = args[args.length - 1];
        const index = this.containers.findIndex((c) => c.id === target || c.name === target);

        if (index !== -1) {
          this.containers.splice(index, 1);
        }

        return ok(`${target}\n`); // `rm -f` of a container that does not exist also succeeds
      }

      case 'ps':
        return this.ps(args);

      default:
        return ok();
    }
  }

  private ps(args: string[]): DockerResult {
    const filters: string[] = [];

    args.forEach((a, i) => {
      if (a === '--filter') {
        filters.push(args[i + 1]);
      }
    });

    const matches = this.containers.filter((c) =>
      this.options.psIgnoresFilters
        ? true
        : filters.every((f) => {
            const [key, ...rest] = f.split('=');
            const value = rest.join('=');

            if (key === 'name') {
              return new RegExp(value).test(c.name);
            }

            if (key === 'label') {
              const [k, v] = value.split('=');

              return v === undefined ? k in c.labels : c.labels[k] === v;
            }

            if (key === 'id') {
              return c.id.startsWith(value);
            }

            return true;
          }),
    );

    return ok(matches.map((c) => `${c.id}|${c.name}|${c.labels[LABEL_KEY] ?? ''}\n`).join(''));
  }
}

export const ours = (id: string, name: string): FakeContainer => ({
  id,
  name,
  labels: { [LABEL_KEY]: LABEL_VALUE },
});
