import { Command } from 'commander';

import { ImportApiClient } from './client';
import { asksAnswerCommand } from './commands/asks/answer';
import { asksApproveCommand } from './commands/asks/approve';
import { asksDeclineCommand } from './commands/asks/decline';
import { asksHistoryCommand } from './commands/asks/history';
import { asksInboxCommand } from './commands/asks/inbox';
import { asksOutboxCommand } from './commands/asks/outbox';
import { asksSendCommand } from './commands/asks/send';
import { asksSendPeerCommand } from './commands/asks/sendPeer';
import { asksShowCommand } from './commands/asks/show';
import { backfillCommand } from './commands/backfill';
import { dataSourcesCommand } from './commands/datasources';
import { doctorCommand } from './commands/doctor';
import { grantsCreateCommand } from './commands/grants/create';
import { grantsHistoryCommand } from './commands/grants/history';
import { grantsListCommand } from './commands/grants/list';
import { grantsRevokeCommand } from './commands/grants/revoke';
import { grantsShowCommand } from './commands/grants/show';
import { grantsUpdateCommand } from './commands/grants/update';
import { importCommand } from './commands/import';
import { inboxCommand } from './commands/inbox';
import { memoryCheckCommand, memoryConfigureCommand, memoryStatusCommand } from './commands/memory';
import { peersAddCommand } from './commands/peers/add';
import { peersListCommand } from './commands/peers/list';
import { peersRevokeCommand } from './commands/peers/revoke';
import { peersUpdateCommand } from './commands/peers/update';
import { pushCommand } from './commands/push';
import { recognizeCommand } from './commands/recognize';
import { runsCommand } from './commands/runs';
import { statsCommand } from './commands/stats';
import type { CliContext } from './context';
import { MemoryGraphQLClient } from './graphqlClient';
import type { Term } from './output';

/** Where the appliance is, when nobody says. The API's own default port. */
export const DEFAULT_SERVER_URL = 'http://localhost:3030';

export interface GlobalOptions {
  server?: string;
  apiKey?: string;
}

export interface ProgramDeps {
  term: Term;
  /** Injected so tests drive the commands without a socket. */
  makeClient?: (options: GlobalOptions) => ImportApiClient;
  /** Injected so tests drive the GraphQL-backed commands (peers/grants/asks) without a socket. */
  makeGraphQLClient?: (options: GlobalOptions) => MemoryGraphQLClient;
  version?: string;
}

/**
 * Resolve where to talk and what to prove.
 *
 * Flag beats environment beats default, and the api key has no default at all:
 * a CLI that silently tried an empty credential would turn "you have not set
 * CI_API_KEY" into an opaque 401 from a route the user has never heard of.
 * `CI_SERVER_API_KEY` is accepted alongside `CI_API_KEY` because both spellings
 * are in use in the surrounding tooling.
 */
export function resolveTarget(
  options: GlobalOptions,
  env: NodeJS.ProcessEnv = process.env,
): { baseUrl: string; apiKey: string | null } {
  return {
    baseUrl: options.server ?? env.CI_SERVER_URL ?? DEFAULT_SERVER_URL,
    apiKey: options.apiKey ?? env.CI_API_KEY ?? env.CI_SERVER_API_KEY ?? null,
  };
}

/**
 * `ci` — the appliance at the command line.
 *
 * Three groups of commands over two protocols: the import spine
 * (`datasources`, `recognize`, `import`, `inbox`, `runs`, `push`) and the
 * appliance-wide `stats`, `doctor` and `backfill` over REST; `peers`, `grants`
 * and `asks` over GraphQL. It was named `ci-import` while it was only the first
 * of those; the alias survives as a deprecation shim.
 *
 * Every command is an HTTP call to a running appliance; see {@link
 * ImportApiClient} for why it is a client rather than an embedded Nest context.
 * The commands themselves take a {@link CliContext} and know nothing about
 * argument parsing, which is what lets the tests exercise them directly and
 * lets this file stay a wiring diagram.
 */
export function buildProgram(deps: ProgramDeps): Command {
  const program = new Command();

  const context = (): CliContext => {
    const options = program.opts<GlobalOptions>();
    const target = resolveTarget(options);

    return {
      term: deps.term,
      client: deps.makeClient
        ? deps.makeClient(options)
        : new ImportApiClient({ baseUrl: target.baseUrl, apiKey: target.apiKey }),
      graphql: deps.makeGraphQLClient
        ? deps.makeGraphQLClient(options)
        : new MemoryGraphQLClient({ baseUrl: target.baseUrl, apiKey: target.apiKey }),
    };
  };

  program
    .name('ci')
    .description(
      'Talk to a Companion Intelligence appliance: import archives, inspect what landed, and manage peers, grants and asks.',
    )
    .version(deps.version ?? '0.0.0')
    .option('--server <url>', 'CI-Server base URL [CI_SERVER_URL]')
    .option('--api-key <key>', 'API key for the appliance [CI_API_KEY]')
    // Commander prints its own help/errors; routing them through the Term keeps
    // every byte this CLI emits testable through one seam.
    .configureOutput({
      writeOut: (text) => deps.term.out(text.replace(/\n$/, '')),
      writeErr: (text) => deps.term.err(text.replace(/\n$/, '')),
    })
    .showHelpAfterError();

  program
    .command('datasources')
    .description('List the importers this appliance ships (71 of them), or the services they cover')
    .option('--catalog', 'list authored services instead of parsers, including ones not yet built')
    .option('--json', 'machine-readable output')
    .action((options) => dataSourcesCommand(context(), options));

  program
    .command('recognize')
    .argument('<path>', 'path on the APPLIANCE, within CI_IMPORT_ROOTS or the inbox')
    .description('Ask every parser what it makes of a path, importing nothing')
    .option('--json', 'machine-readable output')
    .action((path: string, options) => recognizeCommand(context(), path, options));

  program
    .command('import')
    .argument('<path...>', 'archive file(s) on THIS machine')
    .description('Upload archives and run them through unpack → parse → media → push')
    .option('--label <label>', 'display name for the run; defaults to the filename')
    .option('--stages <list>', 'comma-separated stages to run; default is all four')
    .option('--wait', 'follow the runs until they finish')
    .option('--timeout <seconds>', 'give up waiting after this long')
    .option('--json', 'machine-readable output')
    .action((paths: string[], options) => importCommand(context(), paths, options));

  program
    .command('inbox')
    .description('Show what is waiting in the import inbox, and import it')
    .option('--start', 'import the units (the inbox CONSUMES what it imports)')
    .option('--only <sources>', 'keep units recognized as these data sources')
    .option('--skip <sources>', 'drop units recognized as these data sources')
    .option('--units <paths>', 'exact unit paths from a scan')
    .option('--label <label>', 'display name for the runs')
    .option('--wait', 'follow the runs until they finish')
    .option('--timeout <seconds>', 'give up waiting after this long')
    .option('--json', 'machine-readable output')
    .action((options) => inboxCommand(context(), options));

  program
    .command('runs')
    .argument('[runId]', 'a run id, for its stage bar')
    .description('Import runs and their progress')
    .option('--limit <n>', 'how many runs to list')
    .option('--wait', 'follow the run until it finishes')
    .option('--timeout <seconds>', 'give up waiting after this long')
    .option('--json', 'machine-readable output')
    .action((runId: string | undefined, options) => runsCommand(context(), runId, options));

  program
    .command('push')
    .description('Push staged rows into ci.* — the deferred half of an import')
    .option('--run <id>', 'restrict to this run (repeatable)', collect, [])
    .option('--dry-run', 'list what would be pushed')
    .option('--wait', 'follow the runs until they finish')
    .option('--timeout <seconds>', 'give up waiting after this long')
    .option('--json', 'machine-readable output')
    .action((options) => pushCommand(context(), options));

  program
    .command('stats')
    .description('Row counts in ci.*, search-index coverage, and a rollup of this account’s runs')
    .option('--json', 'machine-readable output')
    .action((options) => statsCommand(context(), options));

  program
    .command('doctor')
    .description('Run the data-quality checks over ci.* and report what is wrong')
    .option('--list', 'show the checks and what each one detects, without running them')
    .option('--check <id>', 'run only this check; repeatable', collect, [])
    .option('--timeout <ms>', 'per-statement cap; a check that exceeds it reports TIMEOUT')
    .option('--failures-only', 'hide the checks that came back clean')
    .option('--graphql', 'skip the data-quality suite; only check that /graphql answers for this key')
    .option('--json', 'machine-readable output')
    .action((options) => doctorCommand(context(), options));

  program
    .command('backfill')
    .argument('[stages...]', 'legs to run; none means all of them')
    .description('Run the post-import enrichment chain')
    .option('--list', 'show the legs and what each does')
    .option('--abort-on-error', 'stop at the first failing leg instead of carrying on')
    .option('--json', 'machine-readable output')
    .action((stages: string[], options) => backfillCommand(context(), stages, options));

  // ---------------------------------------------------------------------------
  // Memory inference — the endpoint and first-run reachability check
  // ---------------------------------------------------------------------------

  const memory = program
    .command('memory')
    .description('Inspect, test, or configure Memory’s inference backend');

  memory
    .command('status')
    .description('Show the inference endpoint Memory is using (credentials stay write-only)')
    .option('--json', 'machine-readable output')
    .action((options) => memoryStatusCommand(context(), options));

  memory
    .command('check')
    .description('Test the inference endpoint from the Memory API container')
    .option('--json', 'machine-readable output')
    .action((options) => memoryCheckCommand(context(), options));

  memory
    .command('configure')
    .description('Configure an appliance-owned inference endpoint')
    .requiredOption('--backend <kind>', 'ollama or openai-compatible')
    .requiredOption('--port <port>', 'port exposed to the Memory API container')
    .option('--backend-api-key <key>', 'write-only credential for an OpenAI-compatible backend')
    .option('--clear-api-key', 'remove the appliance-saved backend credential')
    .option('--json', 'machine-readable output')
    .action((options) => memoryConfigureCommand(context(), options));

  // ---------------------------------------------------------------------------
  // Peers — who this box will exchange asks with (backend/.../graphql/resolvers/PeerLinkResolver.ts)
  // ---------------------------------------------------------------------------

  const peers = program
    .command('peers')
    .description('Linked peer Companions, and how far this box trusts them');

  peers
    .command('list')
    .description('Every peer this box knows, revoked ones included')
    .option('--json', 'machine-readable output')
    .action((options) => peersListCommand(context(), options));

  peers
    .command('add')
    .argument('<handle>', "the peer's Portal handle")
    .argument('<memoryEndpoint>', "the peer's appliance URL")
    .description('Link a peer Companion by hand')
    .option('--display-name <name>', 'a friendlier label than the handle')
    .option('--tier <tier>', 'trust tier: family, peer, stranger (default), trusted')
    // Write-only, and paired. Without both, the link is outbound-only: an
    // inbound ask is routed by (issuer, subject), so a link that names neither
    // can never be matched. `peers list` will not read them back.
    .option('--peer-issuer <iss>', "the OIDC issuer of the peer's inbound token (with --peer-subject)")
    .option('--peer-subject <sub>', "the `sub` claim of the peer's inbound token (with --peer-issuer)")
    .option('--json', 'machine-readable output')
    .action((handle: string, memoryEndpoint: string, options) =>
      peersAddCommand(context(), handle, memoryEndpoint, options),
    );

  peers
    .command('update')
    .argument('<id>', 'the peer link id, from `peers list`')
    .description("Change a linked peer's display name, trust tier or inbound identity")
    .option('--display-name <name>')
    .option('--tier <tier>', 'trust tier: family, peer, stranger, trusted')
    .option('--peer-issuer <iss>', "the OIDC issuer of the peer's inbound token (with --peer-subject)")
    .option('--peer-subject <sub>', "the `sub` claim of the peer's inbound token (with --peer-issuer)")
    .option('--json', 'machine-readable output')
    .action((id: string, options) => peersUpdateCommand(context(), id, options));

  peers
    .command('revoke')
    .argument('<id>', 'the peer link id, from `peers list`')
    .description('Stop exchanging asks with a peer')
    .option('--json', 'machine-readable output')
    .action((id: string, options) => peersRevokeCommand(context(), id, options));

  // ---------------------------------------------------------------------------
  // Grants — standing consent, the Grant Manager's matrix (.../resolvers/AskResolver.ts)
  // ---------------------------------------------------------------------------

  const grants = program.command('grants').description('Standing ask-grants — consent given in advance');

  grants
    .command('list')
    .description('Active standing grants owned by the caller')
    .option('--json', 'machine-readable output')
    .action((options) => grantsListCommand(context(), options));

  grants
    .command('show')
    .argument('<id>', 'the grant id, from `grants list` or `grants history`')
    .description('One grant, in full')
    .option('--json', 'machine-readable output')
    .action((id: string, options) => grantsShowCommand(context(), id, options));

  grants
    .command('create')
    .argument(
      '<granteeHandleOrUserId>',
      "a peer's handle (see `peers list`), or a household member's user id",
    )
    .argument('<queryType>', 'the ask archetype: relationship, content, availability, attribute, identity')
    .description('Write a new standing grant')
    .option('--data-class <class>', 'coarse data class this grant covers, e.g. photos')
    .option('--mode <mode>', 'auto, review (default), or block')
    .option('--max-disclosure <rung>', 'ceiling: none, boolean, count, summary, redacted, full')
    .option('--purpose <text>', 'shown to the owner; never widens scope')
    .option('--json', 'machine-readable output')
    .action((granteeHandleOrUserId: string, queryType: string, options) =>
      grantsCreateCommand(context(), granteeHandleOrUserId, queryType, options),
    );

  grants
    .command('update')
    .argument('<id>', 'the grant id, from `grants list`')
    .description('Change a standing grant (writes a new version; see `grants history`)')
    .option('--mode <mode>', 'auto, review, or block')
    .option('--data-class <class>')
    .option('--max-disclosure <rung>', 'none, boolean, count, summary, redacted, full')
    .option('--purpose <text>')
    .option('--expires-at <iso>', 'schedule a lapse')
    .option('--clear-expiry', 'make the grant permanent again')
    .option('--json', 'machine-readable output')
    .action((id: string, options) => grantsUpdateCommand(context(), id, options));

  grants
    .command('revoke')
    .argument('<id>', 'the grant id, from `grants list`')
    .description('Revoke a standing grant (retroactive — see the command docstring)')
    .option('--json', 'machine-readable output')
    .action((id: string, options) => grantsRevokeCommand(context(), id, options));

  grants
    .command('history')
    .argument('[id]', 'narrow to one grant’s own chain of changes; omit for the whole ledger')
    .description('Every grant ever written — active, revoked and superseded')
    .option('--json', 'machine-readable output')
    .action((id: string | undefined, options) => grantsHistoryCommand(context(), id, options));

  // ---------------------------------------------------------------------------
  // Asks — the interpersonal-question lifecycle (.../resolvers/AskResolver.ts)
  // ---------------------------------------------------------------------------

  const asks = program
    .command('asks')
    .description('Interpersonal asks — send them, review them, answer them');

  asks
    .command('inbox')
    .description('Asks awaiting this account’s decision')
    .option('--json', 'machine-readable output')
    .action((options) => asksInboxCommand(context(), options));

  asks
    .command('outbox')
    .description('Asks this account has sent')
    .option('--json', 'machine-readable output')
    .action((options) => asksOutboxCommand(context(), options));

  asks
    .command('show')
    .argument('<id>', 'the ask id, from `asks inbox` or `asks outbox`')
    .description('One ask, and its answer once there is one')
    .option('--json', 'machine-readable output')
    .action((id: string, options) => asksShowCommand(context(), id, options));

  asks
    .command('send')
    .argument('<recipient>', "a household member's user id — this box's own accounts only")
    .argument('<prompt>', 'the natural-language question')
    .description('Submit a LOCAL ask (see `asks send-peer` for a linked peer’s own appliance)')
    .option('--query-type <type>', 'required: relationship, content, availability, attribute, identity')
    .option('--data-class <class>', 'coarse data class, e.g. photos')
    .option('--json', 'machine-readable output')
    .action((recipient: string, prompt: string, options) =>
      asksSendCommand(context(), recipient, prompt, options),
    );

  asks
    .command('send-peer')
    .argument('<handle>', "the linked peer's Portal handle")
    .argument('<prompt>', 'the natural-language question')
    .description('Submit a FEDERATED ask to a linked peer’s own appliance')
    .option('--archetype <archetype>', 'required: relationship, content, or availability')
    .option('--peer-access-token <token>', 'Portal-issued token scoped to the peer [CI_PEER_ACCESS_TOKEN]')
    .option('--subject <text>', 'relationship/content: who or what is being asked about')
    .option('--data-class <class>', 'content: coarse data class, e.g. photos')
    .option('--from <iso>', 'availability (required) / content (optional): window start')
    .option('--to <iso>', 'availability (required) / content (optional): window end')
    .option('--min-minutes <n>', 'availability: minimum contiguous free block worth reporting')
    .option('--purpose <text>', 'shown to the responder; never widens scope')
    .option('--json', 'machine-readable output')
    .action((handle: string, prompt: string, options) =>
      asksSendPeerCommand(context(), handle, prompt, options),
    );

  asks
    .command('approve')
    .argument('<id>', 'the ask id, from `asks inbox`')
    .description('Approve an ask under review, without answering it yet')
    .option('--json', 'machine-readable output')
    .action((id: string, options) => asksApproveCommand(context(), id, options));

  asks
    .command('decline')
    .argument('<id>', 'the ask id, from `asks inbox`')
    .description('Decline an ask under review (terminal)')
    .option('--json', 'machine-readable output')
    .action((id: string, options) => asksDeclineCommand(context(), id, options));

  asks
    .command('answer')
    .argument('<id>', 'the ask id, from `asks inbox`')
    .description('Answer an approved (or auto-authorized) ask, producing the disclosure')
    .option('--redact <itemIds>', 'comma-separated entity ids to withhold, counted but not named')
    .option(
      '--disclosure-form <form>',
      'narrow the answer shape: attribute, boolean, existence, identity, retrieval',
    )
    .option('--json', 'machine-readable output')
    .action((id: string, options) => asksAnswerCommand(context(), id, options));

  asks
    .command('history')
    .description('This account’s disclosure history — asks it has answered, declined, or that expired')
    .option('--counterparty <key>', 'restrict to one asker/peer')
    .option('--outcome <outcomes>', 'comma-separated: answered, auto_answered, declined, expired')
    .option('--from <iso>')
    .option('--to <iso>')
    .option('--limit <n>')
    .option('--json', 'machine-readable output')
    .action((options) => asksHistoryCommand(context(), options));

  // Short lines on purpose: commander re-wraps long ones to the terminal width,
  // and a paragraph that already contains newlines comes out ragged.
  program.addHelpText(
    'after',
    [
      '',
      'Every command is an HTTP call to a running CI-Server, so a run started',
      'here is the same run the web wizard starts.',
      '',
      'Configuration:',
      `  CI_SERVER_URL   where the appliance is [${DEFAULT_SERVER_URL}]`,
      '  CI_API_KEY      an api key; create one in the web UI under',
      '                  Settings → API keys',
      '',
      'Examples:',
      '  ci datasources',
      '  ci recognize /srv/exports/Takeout',
      '  ci import ~/Downloads/takeout-1.zip --wait',
      '  ci inbox',
      '  ci inbox --start --only google_photos --wait',
      '  ci runs',
      '  ci doctor',
      '  ci doctor --json --check comms-missing-thread-id',
      '  ci doctor --graphql',
      '  ci backfill --list',
      '  ci peers add alice@portal.example https://alice.example:3030',
      '  ci peers add alice@portal.example https://alice.example:3030 \\',
      '      --peer-issuer https://portal.example --peer-subject alice-box-a',
      '  ci grants create alice@portal.example content --mode auto --max-disclosure summary',
      '  ci asks inbox',
      '  ci asks answer <id> --disclosure-form boolean',
    ].join('\n'),
  );

  return program;
}

/** Commander's repeatable-option accumulator. */
function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
