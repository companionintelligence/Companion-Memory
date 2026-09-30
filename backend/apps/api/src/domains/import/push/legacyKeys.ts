import type { GraphEntityInputDto } from '@ci/domains/graph';

import type { StagedEntity } from '../entities/StagedEntityEntity';
import { namesDescribeDifferentPeople, normalizeHandle, stagedNaturalKey } from '../staging/identity';

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
 *
 * Emptied of what the CARDS put there, but not of what the row's merges did. A
 * merge is a separate decision: that some other row (a chat participant, a
 * contact from another address book) is this row's person. The row keeps its
 * merges when it moves, so the identity values they folded in stay with it:
 * `emails`, `phones`, `names`, `Phones` and `Faxes`, as far as each source's
 * tombstone still carries them (`GraphIngestService.rekeyImportedEntities`
 * has the rule). Dropping them would lose them for good. Nothing folds a
 * standing merge again, and the survivor repair in #2796 runs once.
 *
 * The exception is a merge that is someone ELSE in the collapse, and the
 * collapse is what makes those. While the row carried every colleague's
 * handles, a stub for one of them could share a handle with it, and
 * `MergeCandidateService` folds a shared email automatically, with no name
 * check. Such a stub's values are the colleague's. Keeping them would hand the
 * heir that colleague's address, which is the contamination the reset exists to
 * remove, and would give the heir and the colleague's new row a shared claim
 * that folds the new row straight back into the heir's. So a merged-away row
 * whose name describes someone other than the heir, or that holds a handle only
 * a colleague's card lists, loses its values along with the rest. Its merge
 * still stands: unpicking a merge is not a re-key's job.
 */

/** An import coordinate as `GraphIngestService` resolves one, less the owner. */
export interface ImportCoordinate {
  entityType: string;
  sourceSystem: string;
  key: string;
}

/** A row merged into an {@link ImportedEntityRow}: a merge tombstone. */
export interface MergedAwayRow {
  entityId: string;
  name: string | null;
  properties?: Record<string, unknown>;
}

/** A row found at an {@link ImportCoordinate}. */
export interface ImportedEntityRow extends ImportCoordinate {
  entityId: string;
  name: string | null;
  properties?: Record<string, unknown>;
  /** The rows merged into it, which a reset must sort into its person's and someone else's. */
  mergedFrom?: readonly MergedAwayRow[];
}

/**
 * One staged contact whose key moved: it resolves under `key` now, and any row
 * it already has was minted under `legacyKey`.
 */
export interface LegacyKeyClaim extends ImportCoordinate {
  legacyKey: string;
  /** What the card calls the person — how a contested row picks its heir. */
  name: string | null;
  /** Every handle the card lists, normalized: how a merge into the row is shown to be a colleague's. */
  handles: readonly string[];
}

/** A row to move, and where. */
export interface LegacyKeyMove {
  entityType: string;
  sourceSystem: string;
  fromKey: string;
  toKey: string;
  /** The row held several people: rebuild it from the heir's card alone. */
  resetProperties: boolean;
  /** Rows merged into it that are someone else in the collapse: the reset drops their values too. */
  dropMergedFrom: string[];
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
  const seen = new Map<string, LegacyKeyClaim>();

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

      if (current.has(coordinateKey(legacy))) {
        continue;
      }

      const earlier = seen.get(claim);

      // One claim per old key and new key. Another staged row making the same
      // claim shares the card's key, so its handles are the card's too.
      if (earlier) {
        earlier.handles = [...new Set([...earlier.handles, ...cardHandles(row)])];
        continue;
      }

      // The CARD's name, not the input's display name: for a card with no
      // usable name that falls back to the handle, which says nothing here.
      const made: LegacyKeyClaim = {
        ...legacy,
        key: input.key,
        legacyKey,
        name: row.name ?? null,
        handles: cardHandles(row),
      };

      seen.set(claim, made);
      claims.push(made);
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
 *
 * A reset keeps what the row's merges brought in, except from the merged-away
 * rows listed in `dropMergedFrom`: those {@link mergedAsSomeoneElse | shown to
 * be someone else} in the collapse. See this module's header for why.
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

    const resetProperties =
      list.some((claim) => namesDescribeDifferentPeople(row.name, claim.name)) ||
      namesListSeveralPeople(row.properties?.Names);

    moves.push({
      entityType: heir.entityType,
      sourceSystem: heir.sourceSystem,
      fromKey: heir.legacyKey,
      toKey: heir.key,
      resetProperties,
      dropMergedFrom: resetProperties ? mergedAsSomeoneElse(row, heir, list) : [],
    });
  }

  return { moves, kept };
}

/**
 * The rows merged into `row` that are someone other than the `heir` it is
 * being rebuilt for. A row counts when its name describes a different person
 * from the one the heir's card names (the row's own name, for a card with no
 * name), or when it holds a handle another claimant's card lists and the heir's
 * card does not.
 *
 * The handle test is for a stub whose name says nothing about who it is: a mail
 * participant minted with its address as its name, a line named by its number.
 * Only claimants whose names describe someone else count as colleagues. One
 * person's other copies of a card are not, whatever they list, and neither is
 * a card with no name. A line every card lists, the heir's included, is
 * nobody's evidence.
 */
function mergedAsSomeoneElse(
  row: ImportedEntityRow,
  heir: LegacyKeyClaim,
  claimants: readonly LegacyKeyClaim[],
): string[] {
  const person = heir.name?.trim() || row.name;
  const own = new Set(heir.handles);
  const theirs = new Set(
    claimants
      .filter((claim) => claim !== heir && namesDescribeDifferentPeople(person, claim.name))
      .flatMap((claim) => claim.handles)
      .filter((handle) => !own.has(handle)),
  );

  return (row.mergedFrom ?? [])
    .filter(
      (merged) =>
        namesDescribeDifferentPeople(person, merged.name) ||
        handlesIn(merged.properties).some((handle) => theirs.has(handle)),
    )
    .map((merged) => merged.entityId);
}

/** The keys a contact card's metadata, or a Person's properties, list handles under. */
const HANDLE_KEYS = ['email', 'emails', 'Emails', 'phone', 'phones', 'Phones', 'Faxes'];

/**
 * Every handle a bag lists under {@link HANDLE_KEYS}, as a lone value or a
 * list, normalized the way staging compares handles: a lower-cased address, a
 * number's last ten digits.
 */
function handlesIn(properties: Record<string, unknown> | null | undefined): string[] {
  const out = new Set<string>();

  for (const key of HANDLE_KEYS) {
    const value = properties?.[key];

    for (const item of Array.isArray(value) ? value : [value]) {
      const handle = normalizeHandle(item);

      if (handle) {
        out.add(handle);
      }
    }
  }

  return [...out];
}

/** Every handle a staged card lists: the ones it is keyed on, then its metadata's. */
function cardHandles(row: StagedEntity): string[] {
  const keys = [row.identityKey, row.legacyIdentityKey]
    .map(normalizeHandle)
    .filter((handle) => handle !== '');

  return [...new Set([...keys, ...handlesIn(row.metadata)])];
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
