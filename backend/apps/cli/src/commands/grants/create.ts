import type { CliContext } from '../../context';
import { json } from '../../output';
import {
  DISCLOSURE_RUNGS,
  GRANT_MODES,
  describeGrantee,
  parseEnumFlag,
  requireSuccess,
  resolveGrantee,
  type DisclosureRungFlag,
  type GrantModeFlag,
} from '../memoryShared';

export interface GrantsCreateOptions {
  dataClass?: string;
  mode?: string;
  maxDisclosure?: string;
  purpose?: string;
  json?: boolean;
}

/**
 * Write a new standing grant — the Grant Manager's matrix, one row.
 *
 * `<granteeHandleOrUserId>` is resolved by {@link resolveGrantee}: if it names
 * one of the caller's peer links (`peers list`), the grant addresses that
 * peer; otherwise it is a raw user id for a household member. Either way,
 * exactly one of `createAskGrant`'s two grantee fields is set — this CLI
 * cannot produce the "must name exactly one of granteeId / granteePeerLinkId"
 * 400 a raw GraphQL caller can.
 *
 * `<queryType>` is the ask archetype (`relationship`, `content`,
 * `availability`, `attribute`, `identity`) and is intentionally NOT validated
 * here — the server's vocabulary (`askInput.ts#parseGrantQueryType`) is the one
 * source of truth, and its `BAD_USER_INPUT` message already names the valid
 * set, so surfacing it verbatim beats a second copy that could drift.
 *
 * `--mode` defaults to `review` — the same fallback `GrantService.create`
 * itself uses when a caller reaches it without one — so an operator who only
 * cares about the disclosure ceiling does not have to spell out the safest
 * posture explicitly.
 */
export async function grantsCreateCommand(
  ctx: CliContext,
  granteeHandleOrUserId: string,
  queryType: string,
  options: GrantsCreateOptions = {},
): Promise<void> {
  const mode = parseEnumFlag<GrantModeFlag>('--mode', options.mode, GRANT_MODES) ?? 'review';
  const maxDisclosure = parseEnumFlag<DisclosureRungFlag>(
    '--max-disclosure',
    options.maxDisclosure,
    DISCLOSURE_RUNGS,
  );
  const grantee = await resolveGrantee(ctx, granteeHandleOrUserId);

  const { grant } = requireSuccess(
    await ctx.graphql.createAskGrant({
      ...grantee,
      queryType,
      dataClass: options.dataClass,
      maxDisclosure,
      mode,
      purpose: options.purpose,
    }),
  );

  if (options.json) {
    json(ctx.term, grant);

    return;
  }

  ctx.term.out(
    `Created grant ${grant?.id} — ${grant ? describeGrantee(grant) : granteeHandleOrUserId} ` +
      `may ask "${queryType}", mode ${grant?.mode}.`,
  );
}
