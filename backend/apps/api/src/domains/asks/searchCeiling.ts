import { DISCLOSURE_RUNGS } from './policy';
import type { DisclosureRung } from './types';

/**
 * The disclosure ladder, applied to a SEARCH RESULT SET.
 *
 * `policy.applyDisclosureCeiling` clamps a {@link DisclosedAnswer} — the shape
 * an ask produces. A shared saved search discloses a different shape (paged
 * result edges, a total, tag facets) and therefore needs its own clamp, and the
 * whole point of writing it here, beside the ask one, is that there must be
 * exactly TWO of them and they must be built the same way.
 *
 * ═══ WHY THIS IS A TABLE AND NOT A `switch` ═══
 *
 * `PeerAskService.clampAvailability` is the third clamp in this codebase, it
 * was written as a `switch`, and it treats `redacted` identically to `full` —
 * so the `trusted` tier's `redacted` ceiling discloses the owner's real calendar
 * boundaries (docs/asks-threat-model.md D2). That is the same defect
 * `applyDisclosureCeiling` had already found and fixed for items, with the
 * argument that *a rung which clamps nothing is not a rung, it is a label the
 * owner can pick believing it does something* — and the argument did not travel
 * to the next clamp somebody wrote.
 *
 * A `switch` cannot be checked for that. A table can: {@link SHARE_DISCLOSURE}
 * states, per rung, exactly which axes are disclosed, and
 * `searchCeiling.spec.ts` walks the ladder asserting that every rung discloses
 * a SUPERSET of the rung below it and strictly more than it on at least one
 * axis. A new rung that clamps nothing fails that test; so does re-pointing an
 * existing rung at its neighbour's row, which is precisely what D2 is.
 *
 * CI-Server #1711 -> epic #1712.
 */

/**
 * What a rung permits, as independent axes.
 *
 * Deliberately booleans-and-an-enum rather than a projection function: the
 * monotonicity property has to be *decidable* by reading the table, and a
 * function body is not.
 */
export interface ShareDisclosure {
  /** Result edges cross to the reader at all. */
  items: boolean;
  /**
   * How much of the match set's size the reader learns.
   *
   * `none` — nothing (reported as 0);
   * `existence` — whether it is empty (reported as 0 or 1);
   * `exact` — the real total.
   */
  magnitude: 'none' | 'existence' | 'exact';
  /** Matching tag facets cross to the reader. */
  facets: boolean;
  /**
   * The reader may page BEYOND the window they were handed.
   *
   * This is what separates `redacted` from `full`, and it is the direct
   * analogue of the ask ladder's `withheldCount`: at `full` the reader can walk
   * the whole set the owner shared, at `redacted` they get the window and
   * nothing about the rest. Without it `redacted` would be a synonym for
   * `full`, which is D2.
   */
  paging: boolean;
}

/**
 * The ladder, coarsest first. Every row must disclose a superset of the row
 * above it — pinned by the monotonicity test, not by review.
 */
export const SHARE_DISCLOSURE: Readonly<Record<DisclosureRung, ShareDisclosure>> = {
  none: { items: false, magnitude: 'none', facets: false, paging: false },
  boolean: { items: false, magnitude: 'existence', facets: false, paging: false },
  count: { items: false, magnitude: 'exact', facets: false, paging: false },
  summary: { items: false, magnitude: 'exact', facets: true, paging: false },
  redacted: { items: true, magnitude: 'exact', facets: true, paging: false },
  full: { items: true, magnitude: 'exact', facets: true, paging: true },
};

/** The minimum structural shape this clamp needs. Keeps GraphQL types out of the domain. */
export interface ClampableConnection<TEdge, TTag> {
  edges: TEdge[];
  pageInfo: {
    hasNextPage: boolean;
    hasPreviousPage: boolean;
    startCursor: string | null;
    endCursor: string | null;
  };
  totalCount: number;
  matchingTags: TTag[];
}

/** PageInfo for a connection the reader may not page out of. */
const SEALED_PAGE_INFO = {
  hasNextPage: false,
  hasPreviousPage: false,
  startCursor: null,
  endCursor: null,
} as const;

/**
 * Clamp a result connection down to `ceiling`.
 *
 * Downgrading only ever REMOVES information, on every axis independently. Pure:
 * the input is not mutated, and nothing here reads a clock, a config or a
 * database.
 *
 * `undefined` means "no ceiling from this source" — the same reading
 * `narrowestRung` gives it — and returns the connection untouched. A ceiling
 * that is PRESENT but names no rung is the opposite case and is the caller's
 * problem: {@link ceilingForShare} resolves that one, and fails closed.
 */
export function applySearchCeiling<TEdge, TTag>(
  connection: ClampableConnection<TEdge, TTag>,
  ceiling: DisclosureRung | undefined,
): ClampableConnection<TEdge, TTag> {
  if (ceiling == null) {
    return connection;
  }

  const permits = SHARE_DISCLOSURE[ceiling];

  return {
    edges: permits.items ? connection.edges : [],
    // Sealed whenever the reader may not page beyond their window. Note this is
    // keyed on `paging`, not on `items`: a rung that hands over a window but
    // forbids walking past it still has to say so here, or the client offers a
    // "Load more" that the server will refuse.
    pageInfo: permits.paging ? connection.pageInfo : SEALED_PAGE_INFO,
    totalCount: clampMagnitude(connection.totalCount, permits.magnitude),
    matchingTags: permits.facets ? connection.matchingTags : [],
  };
}

function clampMagnitude(total: number, magnitude: ShareDisclosure['magnitude']): number {
  switch (magnitude) {
    case 'exact':
      return total;
    case 'existence':
      return total > 0 ? 1 : 0;
    case 'none':
    default:
      return 0;
  }
}

/**
 * Resolve the ceiling a share declares, from the raw column value.
 *
 * ABSENT AND UNREADABLE ARE DIFFERENT, and this is the same asymmetry
 * `grantMatch.ceilingOf` draws:
 *
 * - NULL/undefined is "this share declares no ceiling" and yields `undefined`,
 *   which {@link applySearchCeiling} passes through untouched. Every share that
 *   existed before this column did reads that way, and they must keep working.
 * - Anything PRESENT that does not name a rung yields `none` — the strictest
 *   rung, not the absence of one. `share_max_disclosure` is a plain TEXT column
 *   behind a CHECK, and a CHECK added by a migration does not vet the rows a
 *   future migration writes. A typo in the owner's own restriction must not be
 *   the loosest reading of it.
 *
 * Pure. Total over `unknown` so it can be pointed at a raw column read.
 */
export function ceilingForShare(declared: unknown): DisclosureRung | undefined {
  if (declared == null) {
    return undefined;
  }

  if (typeof declared !== 'string') {
    return 'none';
  }

  const canonical = declared.trim().toLowerCase();

  return (DISCLOSURE_RUNGS as readonly string[]).includes(canonical) ? (canonical as DisclosureRung) : 'none';
}
