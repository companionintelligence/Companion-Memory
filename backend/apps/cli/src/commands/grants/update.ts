import { CliError, type CliContext } from '../../context';
import { json } from '../../output';
import {
  DISCLOSURE_RUNGS,
  GRANT_MODES,
  parseEnumFlag,
  requireSuccess,
  type DisclosureRungFlag,
  type GrantModeFlag,
} from '../memoryShared';

export interface GrantsUpdateOptions {
  mode?: string;
  dataClass?: string;
  maxDisclosure?: string;
  purpose?: string;
  expiresAt?: string;
  clearExpiry?: boolean;
  json?: boolean;
}

/**
 * Change a standing grant — applied as a supersede (`GrantService.supersede`),
 * not an in-place update: the old row is closed out and a new one replaces it,
 * so the consent audit trail (`grants history`) can reconstruct what the owner
 * allowed and until when.
 *
 * ═══ EVERY OMITTED FIELD IS **OMITTED**, NEVER SENT AS `null` ═══
 *
 * The variables object below only gets a key for a flag the caller actually
 * passed — `JSON.stringify` then drops every `undefined` property entirely.
 * That distinction is load-bearing: the server tells "leave this dimension
 * alone" (undefined) from "clear it" (explicit null) apart, which is what lets
 * a disclosure ceiling set by an earlier `grants create --max-disclosure`
 * SURVIVE an unrelated `grants update --mode block` instead of silently
 * widening back to "no ceiling". Building this object with `?? null` instead
 * of leaving the key out is exactly the bug that would reopen — see
 * `UpdateAskGrantInput`'s own schema docstring for the history.
 */
export async function grantsUpdateCommand(
  ctx: CliContext,
  id: string,
  options: GrantsUpdateOptions = {},
): Promise<void> {
  if (options.expiresAt != null && options.clearExpiry) {
    throw new CliError('Pass either --expires-at or --clear-expiry, not both.');
  }

  const mode = parseEnumFlag<GrantModeFlag>('--mode', options.mode, GRANT_MODES);
  const maxDisclosure = parseEnumFlag<DisclosureRungFlag>(
    '--max-disclosure',
    options.maxDisclosure,
    DISCLOSURE_RUNGS,
  );

  if (
    mode == null &&
    options.dataClass == null &&
    maxDisclosure == null &&
    options.purpose == null &&
    options.expiresAt == null &&
    !options.clearExpiry
  ) {
    throw new CliError(
      'Nothing to update — pass at least one of --mode, --data-class, --max-disclosure, --purpose, --expires-at, --clear-expiry.',
    );
  }

  const { grant } = requireSuccess(
    await ctx.graphql.updateAskGrant(id, {
      mode,
      dataClass: options.dataClass,
      maxDisclosure,
      purpose: options.purpose,
      expiresAt: options.expiresAt,
      clearExpiry: options.clearExpiry,
    }),
  );

  if (options.json) {
    json(ctx.term, grant);

    return;
  }

  ctx.term.out(
    `Updated grant ${grant?.id} (v${grant?.version}) — mode ${grant?.mode}` +
      `${grant?.expiresAt ? `, expires ${grant.expiresAt}` : ''}.`,
  );
}
