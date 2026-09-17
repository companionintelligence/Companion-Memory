import type { ImportApiClient } from './client';
import type { MemoryGraphQLClient } from './graphqlClient';
import type { Term } from './output';

/**
 * What every command is handed: somewhere to ask, somewhere to answer.
 *
 * Two clients, not one, because the appliance speaks two protocols for two
 * halves of the CLI: `client` is the REST surface the import domain publishes,
 * `graphql` is `POST /graphql` for the memory surface (peers, ask-grants, asks)
 * that has no REST equivalent. A command uses whichever one its feature is
 * actually served over — most use exactly one.
 */
export interface CliContext {
  client: ImportApiClient;
  graphql: MemoryGraphQLClient;
  term: Term;
}

/**
 * A failure the CLI expected and can explain — a path that is not a file, an
 * inbox that is not mounted, a stage name that does not exist.
 *
 * Distinct from a thrown `Error` so the entry point can print a sentence and
 * exit 2 for these, and a stack trace and exit 1 for anything else: the first
 * is the user's to fix, the second is ours.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = 2,
  ) {
    super(message);
    this.name = 'CliError';
  }
}
