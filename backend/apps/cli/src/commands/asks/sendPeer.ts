import { CliError, type CliContext } from '../../context';
import { json } from '../../output';
import { requireSuccess } from '../memoryShared';

export interface AsksSendPeerOptions {
  archetype?: string;
  subject?: string;
  dataClass?: string;
  from?: string;
  to?: string;
  minMinutes?: string;
  purpose?: string;
  peerAccessToken?: string;
  json?: boolean;
}

/** Env var carrying a Portal-issued access token, when `--peer-access-token` is left off. */
export const PEER_ACCESS_TOKEN_ENV = 'CI_PEER_ACCESS_TOKEN';

/**
 * The OUTBOUND half of federation (epic #1725): ask a LINKED PEER'S OWN
 * appliance a question, over its Portal-brokered channel, rather than a local
 * household member (that is `asks send`).
 *
 * `--archetype` is required — `SendPeerAskInput.archetype` is non-nullable —
 * and is one of `relationship`, `content` or `availability` (the federated
 * protocol's own vocabulary; narrower than the five local ask archetypes,
 * since `attribute` and `identity` have no federated wire shape yet).
 *
 * The access token is never minted here. `SendPeerAskInput.peerAccessToken`'s
 * own schema docstring says why: "supplied by the caller until Portal token
 * exchange lands; this box never mints or stores it." The CLI's job is only to
 * accept whatever the operator already obtained, from a flag or from
 * `CI_PEER_ACCESS_TOKEN`, and pass it through unchanged.
 */
export async function asksSendPeerCommand(
  ctx: CliContext,
  handle: string,
  prompt: string,
  options: AsksSendPeerOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (options.archetype == null) {
    throw new CliError('--archetype is required: one of relationship, content, availability.');
  }

  const peerAccessToken = options.peerAccessToken ?? env[PEER_ACCESS_TOKEN_ENV];

  if (peerAccessToken == null) {
    throw new CliError(
      `A peer access token is required: pass --peer-access-token or set ${PEER_ACCESS_TOKEN_ENV}.`,
    );
  }

  const minMinutes = parseMinMinutes(options.minMinutes);

  const { ask, status, reason } = requireSuccess(
    await ctx.graphql.sendPeerAsk({
      handle,
      prompt,
      archetype: options.archetype,
      subject: options.subject,
      dataClass: options.dataClass,
      from: options.from,
      to: options.to,
      minMinutes,
      purpose: options.purpose,
      peerAccessToken,
    }),
  );

  if (options.json) {
    json(ctx.term, { ask, status, reason });

    return;
  }

  ctx.term.out(`Sent to ${handle} — ${status}${reason ? ` (${reason})` : ''}.`);
}

function parseMinMinutes(value: string | undefined): number | undefined {
  if (value == null) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    throw new CliError(`--min-minutes takes a number, got "${value}".`);
  }

  return parsed;
}
