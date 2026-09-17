import type { ImportApiClient } from '../../client';
import type { CliContext } from '../../context';
import type { MemoryGraphQLClient } from '../../graphqlClient';
import type { Term } from '../../output';

export interface RecordingTerm extends Term {
  lines: string[];
  errors: string[];
  /** Everything written to stdout, joined — for asserting on shape, not spacing. */
  text(): string;
  errorText(): string;
}

export function recordingTerm(isTTY = false): RecordingTerm {
  const lines: string[] = [];
  const errors: string[] = [];

  return {
    lines,
    errors,
    isTTY,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    text: () => lines.join('\n'),
    errorText: () => errors.join('\n'),
  };
}

/**
 * A context whose client answers only the calls a test names.
 *
 * Anything else throws by name rather than returning undefined: a command that
 * quietly calls one more endpoint than the test expected should fail loudly,
 * not pass against `undefined`.
 */
export function harness(
  client: Partial<ImportApiClient>,
  graphql: Partial<MemoryGraphQLClient> = {},
): CliContext & { term: RecordingTerm } {
  const term = recordingTerm();

  return {
    term,
    client: stubClient(client, 'client'),
    graphql: stubClient(graphql, 'graphql') as MemoryGraphQLClient,
  };
}

/** The throw-by-name proxy `harness` builds for each of its two clients. */
function stubClient<T extends object>(stub: Partial<T>, label: string): T {
  return new Proxy(stub, {
    get(target, property) {
      const value = target[property as keyof T];

      if (value === undefined && typeof property === 'string' && property !== 'then') {
        throw new Error(`the test did not stub ${label}.${String(property)}`);
      }

      return value;
    },
  }) as T;
}
