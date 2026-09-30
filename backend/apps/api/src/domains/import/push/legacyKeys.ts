import type { GraphEntityInputDto } from '@ci/domains/graph';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import { namesDescribeDifferentPeople, stagedNaturalKey } from '../staging/identity';

import { naturalKeyFor } from './entities';

/**
 * Moving existing rows onto contacts' new keys.
 *
 * `entityIdentityKey` stopped keying contacts on handles that are not theirs
 * alone (a fax, an office line other people's cards list), so every contact
 * whose smallest handle was such a line now resolves under a DIFFERENT natural
 * key than the one its `ci.entities` row was minted under. `GraphIngestService`
 * resolves by that key and nothing else, so left alone the next import of the
 * same export would mint a second Person beside each of them.
 *
 * A migration cannot move those rows: which handle was a fax is a TEL type, and
 * which was shared is a fact about the export's OTHER cards, and neither
 * survives staging — `ci.entities` keeps only each entity's merged union of
 * handles. The parser does know, so staging records the old key next to the new
 * one (`staged_entities.legacy_identity_key`) and the push moves the old row
 * here, just before ingest looks it up. The row keeps its id — its edges,
 * identifiers, merges and search index come with it — and the ingest that
 * follows overwrites its name and properties with what the card now says.
 *
 * That is also what separates a COLLAPSED Person. Three colleagues keyed on
 * one switchboard were one row; each of them now claims it. The row goes to the
 * one it is named after (it carries the name of whichever card staged first),
 * and the others are minted fresh — see {@link planLegacyKeyMoves}. It moves
 * with its properties EMPTIED, so the ingest rebuilds them from that one card:
 * it must not matter whether ingest replaces a row's properties (as it does
 * today) or unions its lists into them, because a union would keep every
 * colleague's name and address on the row.
 */

/** An import coordinate as `GraphIngestService` resolves one, less the owner. */
export interface ImportCoordinate {
  entityType: string;
  sourceSystem: string;
  key: string;
}

/** A row found at an {@link ImportCoordinate}. */
export interface ImportedEntityRow extends ImportCoordinate {
  entityId: string;
  name: string | null;
  properties?: Record<string, unknown>;
}

/**
 * One staged contact whose key moved: it resolves under `key` now, and any row
 * it already has was minted under `legacyKey`.
 */
export interface LegacyKeyClaim extends ImportCoordinate {
  legacyKey: string;
  /** What the card calls the person — how a contested row picks its heir. */
  name: string | null;
}

/** A row to move, and where. */
export interface LegacyKeyMove {
  entityType: string;
  sourceSystem: string;
  fromKey: string;
  toKey: string;
  /** The row held several people: rebuild it from the heir's card alone. */
  resetProperties: boolean;
}

export interface LegacyKeyPlan {
  moves: LegacyKeyMove[];
  /**
   * Rows found under an old key that stay where they are: every card claiming
   * them now names someone else, or the new key already has a row of its own.
   * Left for a person to look at — the `contact-person-merges-several-people`
   * doctor check counts the collapsed ones.
   */
  kept: number;
}

/**
 * The natural key a staged row resolved under before shared handles were passed
 * over, or null when it has none or the key did not move.
 */
export function legacyNaturalKeyFor(staged: StagedEntity): string | null {
  if (!staged.legacyIdentityKey) {
    return null;
  }

  const legacy = stagedNaturalKey(staged.type, staged.legacyIdentityKey, staged.name);

  return legacy != null && legacy !== naturalKeyFor(staged) ? legacy : null;
}

/**
 * The claims one push makes: every staged row whose key moved, against the
 * input it is being ingested as.
 *
 * A row only claims under its own input's source. Several staged rows can
 * share one natural key, and ingest sends only the first of them — so a row of
 * a DIFFERENT source riding along with it would claim a row the ingest never
 * looks at.
 *
 * An old key that is still some input's CURRENT key is not claimable at all:
 * its row belongs to that input, which is about to resolve to it — the case
 * where a card that never listed the shared line (or listed it alone) keeps it.
 */
export function legacyKeyClaims(
  batch: ReadonlyArray<{ input: GraphEntityInputDto; rows: readonly StagedEntity[] }>,
): LegacyKeyClaim[] {
  const current = new Set(batch.map(({ input }) => coordinateKey(input)));
  const claims: LegacyKeyClaim[] = [];
  const seen = new Set<string>();

  for (const { input, rows } of batch) {
    for (const row of rows) {
      if ((row.dataSource ?? 'unknown') !== input.sourceSystem) {
        continue;
      }

      const legacyKey = legacyNaturalKeyFor(row);

      if (legacyKey == null) {
        continue;
      }

      const legacy = { entityType: input.entityType, sourceSystem: input.sourceSystem, key: legacyKey };
      const claim = `${coordinateKey(legacy)}\u001f${input.key}`;

      if (current.has(coordinateKey(legacy)) || seen.has(claim)) {
        continue;
      }

      seen.add(claim);
      // The CARD's name, not the input's display name: for a card with no
      // usable name that falls back to the handle, which says nothing here.
      claims.push({ ...legacy, key: input.key, legacyKey, name: row.name ?? null });
    }
  }

  return claims;
}

/**
 * Every coordinate {@link planLegacyKeyMoves} needs to see: the old key of each
 * claim (is there a row to move?) and its new one (is the destination free?).
 */
export function claimedCoordinates(claims: readonly LegacyKeyClaim[]): ImportCoordinate[] {
  const out = new Map<string, ImportCoordinate>();

  for (const claim of claims) {
    for (const key of [claim.legacyKey, claim.key]) {
      const coordinate = { entityType: claim.entityType, sourceSystem: claim.sourceSystem, key };

      out.set(coordinateKey(coordinate), coordinate);
    }
  }

  return [...out.values()];
}

/**
 * Decide which old rows move onto which new keys. Pure: `found` is whatever
 * currently sits at {@link claimedCoordinates}.
 *
 * A row moves to one claimant, chosen in this order:
 *  - never one whose name {@link namesDescribeDifferentPeople | says it is
 *    someone else} than the name the row carries — a card that merely used to
 *    share a line with the row's person does not inherit that person's history;
 *  - never onto a key that already has a row, or that an earlier move in this
 *    plan took;
 *  - of the rest, the one named exactly as the row is, else the first in
 *    staging order.
 *
 * A row nobody qualifies for stays put and is counted in `kept`.
 *
 * A moved row is marked `resetProperties` when it is shown to have held more
 * than one person: another claimant's name says so, or the `Names` the row
 * already accumulated do. One person's own copies claiming it (a fragment each)
 * do not reset it — their details are all theirs.
 */
export function planLegacyKeyMoves(
  claims: readonly LegacyKeyClaim[],
  found: readonly ImportedEntityRow[],
): LegacyKeyPlan {
  const rowAt = new Map(found.map((row) => [coordinateKey(row), row]));
  const claimants = new Map<string, LegacyKeyClaim[]>();

  for (const claim of claims) {
    const from = coordinateKey({ ...claim, key: claim.legacyKey });
    const list = claimants.get(from);

    if (list) {
      list.push(claim);
    } else {
      claimants.set(from, [claim]);
    }
  }

  const taken = new Set<string>();
  const moves: LegacyKeyMove[] = [];
  let kept = 0;

  for (const [from, list] of claimants) {
    const row = rowAt.get(from);

    if (row == null) {
      continue;
    }

    const eligible = list.filter(
      (claim) =>
        !namesDescribeDifferentPeople(row.name, claim.name) &&
        !rowAt.has(coordinateKey(claim)) &&
        !taken.has(coordinateKey(claim)),
    );
    const heir = eligible.find((claim) => sameName(claim.name, row.name)) ?? eligible[0];

    if (heir == null) {
      kept += 1;
      continue;
    }

    taken.add(coordinateKey(heir));
    moves.push({
      entityType: heir.entityType,
      sourceSystem: heir.sourceSystem,
      fromKey: heir.legacyKey,
      toKey: heir.key,
      resetProperties:
        list.some((claim) => namesDescribeDifferentPeople(row.name, claim.name)) ||
        namesListSeveralPeople(row.properties?.Names),
    });
  }

  return { moves, kept };
}

/** True when a stored `Names` list holds two names of different people. */
function namesListSeveralPeople(names: unknown): boolean {
  if (!Array.isArray(names)) {
    return false;
  }

  const strings = names.filter((name): name is string => typeof name === 'string');

  return strings.some((name, index) =>
    strings.slice(index + 1).some((other) => namesDescribeDifferentPeople(name, other)),
  );
}

function coordinateKey(coordinate: ImportCoordinate): string {
  return `${coordinate.entityType}\u001f${coordinate.sourceSystem}\u001f${coordinate.key}`;
}

function sameName(left: string | null | undefined, right: string | null | undefined): boolean {
  const fold = (name: string | null | undefined) => (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

  return fold(left) !== '' && fold(left) === fold(right);
}
