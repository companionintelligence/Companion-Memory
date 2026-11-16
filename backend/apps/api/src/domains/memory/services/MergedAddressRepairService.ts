import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, type EntityManager } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { serves } from '@ci/common/roles';
import { stableJson } from '@ci/common/stableJson';
import { USER_EDITED_KEYS } from '@ci/common/userEditedProperties';
import { EventService } from '@ci/domains/events';
import { PersonUpdatedEvent } from '@ci/domains/memory/events';

import {
  type PersonAddress,
  PERSON_ADDRESS_MIRROR_KEYS,
  readPersonAddresses,
  readStoredPersonAddress,
} from '../types';

import { GraphDeltaWriter, changedFieldsBetween } from './GraphDeltaWriter';
import { ADDRESS_KEYS, ADDRESSES_FOLDED, addressKey, withFoldedAddresses } from './PersonMergeService';

/** How the flat keys of an edit name an address's parts. */
const FLAT_ADDRESS_PARTS: ReadonlyArray<readonly [string, keyof PersonAddress]> = [
  ['street_address', 'streetAddress'],
  ['street_address_2', 'streetAddress2'],
  ['city', 'city'],
  ['region', 'region'],
  ['postal_code', 'postalCode'],
  ['country', 'country'],
];

/** Long enough for pg-boss and the pool to settle after a deploy, as the boot sweeps elsewhere wait. */
const BOOT_DELAY_MS = 30_000;

/** One Person merge that still stands and has not had its addresses put back. */
interface StandingMerge {
  merge_id: string;
  owner_user_id: string;
  survivor_id: string;
  /** The person the merge went into: the survivor, or a row merged into it later. */
  target_id: string;
  created_at: Date;
}

/** The two bags one merge's addresses are read from, loaded under the survivor's lock. */
interface MergeBags {
  merge_id: string;
  /** `ci.entity_merges.details.sourceProperties`: the source's bag at merge time. */
  snapshot: Record<string, unknown>;
  /** The source's tombstone bag today. */
  tombstone: Record<string, unknown> | null;
}

/** An app edit of the survivor's addresses after a merge, as `ci.graph_deltas` holds it. */
export interface AddressEdit {
  changed_at: Date;
  changed_fields: Record<string, { old?: unknown; new?: unknown }>;
}

export interface MergedAddressRepairResult {
  /** Merges looked at, each now flagged so no later run reads it again. */
  merges: number;
  /** People whose addresses changed. */
  people: number;
  /** Addresses a person had removed by hand after the merge, left off. */
  leftOff: number;
}

/**
 * Puts back the addresses that merges made before the fold kept them dropped.
 *
 * Until #3551 a person merge kept only the target's `addresses` list, and a
 * person made with + > Person carries `addresses: []`, so every address of the
 * person merged into it was lost from the kept one. The fold also copied the
 * source's flat street and city in when the target had none, which is why the
 * kept person showed one unlabelled address. Each lost address is still in the
 * merge's `ci.entity_merges.details.sourceProperties`.
 *
 * For each merge that still stands (the same rule as
 * 20260930025958_restore_merged_person_identity_lists: the target, or the row
 * it was merged into later, is a live Person, and the source's tombstone still
 * points at it), the source's addresses are folded onto the person with
 * {@link withFoldedAddresses}, the merge's own address fold: each address once,
 * the kept person's primary still primary, its flat keys in step, a hand-set
 * key kept and a hand-cleared address left cleared. Owner-scoped throughout.
 *
 * An address comes back only if the source's tombstone still holds it, so a
 * later repair of the tombstone is respected. An address the person removed by
 * hand after the merge stays off: an edit through the app writes a
 * `PersonService` row into `ci.graph_deltas` with the old and new address list,
 * or the old and new flat fields, and an address on the old side and not on the
 * new is left out. An address removed any other way (an import that rewrote the
 * bag, a direct database edit) leaves no such trace and comes back.
 *
 * Each merge read is flagged `addressesFolded` in its `details`, whether
 * anything changed or not, so the repair runs once per merge: a second run
 * reads nothing, and an address the person removes after the repair stays
 * removed. Merges from #3551 on set the flag themselves.
 *
 * It runs once after each start of a worker process, 30 seconds in, and logs
 * what it did.
 */
@Injectable()
export class MergedAddressRepairService implements OnApplicationBootstrap {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {
    this.logger.setContext(MergedAddressRepairService.name);
  }

  onApplicationBootstrap(): void {
    // Only one process needs to: two would race over the same merges.
    if (!serves('worker')) {
      return;
    }

    // Logged, never thrown: a repair that fails must not stop the appliance
    // from starting, and the merges it did not reach are read on the next start.
    setTimeout(() => {
      this.repair().catch((err) => {
        this.logger.warn('Could not put back addresses from earlier person merges', { err });
      });
    }, BOOT_DELAY_MS);
  }

  /** Every owner's merges, or only `ownerUserIds`' when given. */
  async repair(ownerUserIds?: string[]): Promise<MergedAddressRepairResult> {
    const merges: StandingMerge[] = await this.dataSource.query(
      `SELECT m.merge_id,
              m.owner_user_id,
              survivor.entity_id                AS survivor_id,
              m.target_entity_id                AS target_id,
              m.created_at
         FROM ci.entity_merges m
         JOIN ci.entities target
           ON target.entity_id = m.target_entity_id
          AND target.owner_user_id = m.owner_user_id
         JOIN ci.entities survivor
           ON survivor.entity_id = COALESCE(target.merged_into_entity_id, target.entity_id)
          AND survivor.owner_user_id = m.owner_user_id
         JOIN ci.entities source
           ON source.entity_id = m.source_entity_id
          AND source.owner_user_id = m.owner_user_id
        WHERE m.entity_type = 'Person'
          AND NOT (m.details ? $1)
          AND jsonb_typeof(m.details -> 'sourceProperties') = 'object'
          AND target.entity_type = 'Person'
          AND survivor.entity_type = 'Person'
          AND survivor.merged_into_entity_id IS NULL
          AND COALESCE(survivor.is_active, TRUE)
          AND source.entity_type = 'Person'
          AND source.merged_into_entity_id = survivor.entity_id
          AND ($2::uuid[] IS NULL OR m.owner_user_id = ANY($2::uuid[]))
        ORDER BY m.owner_user_id, survivor.entity_id, m.created_at, m.merge_id`,
      [ADDRESSES_FOLDED, ownerUserIds ?? null],
    );

    const bySurvivor = new Map<string, StandingMerge[]>();
    for (const merge of merges) {
      const key = `${merge.owner_user_id}/${merge.survivor_id}`;
      const group = bySurvivor.get(key);

      if (group) {
        group.push(merge);
      } else {
        bySurvivor.set(key, [merge]);
      }
    }

    const result: MergedAddressRepairResult = { merges: 0, people: 0, leftOff: 0 };

    for (const group of bySurvivor.values()) {
      try {
        const outcome = await this.repairPerson(group);
        result.merges += outcome.flagged;
        result.people += outcome.changed ? 1 : 0;
        result.leftOff += outcome.leftOff;
      } catch (err) {
        // One person's failure leaves the others to be repaired; its merges stay
        // unflagged and are read again on the next start.
        this.logger.warn('Could not put back the addresses merged into a person', {
          err,
          ownerUserId: group[0].owner_user_id,
          personId: group[0].survivor_id,
        });
      }
    }

    if (merges.length > 0) {
      this.logger.log('Addresses from earlier person merges put back', { ...result });
    }

    return result;
  }

  /** Folds every standing merge into one person, in one transaction, oldest merge first. */
  private async repairPerson(
    merges: StandingMerge[],
  ): Promise<{ changed: boolean; leftOff: number; flagged: number }> {
    const { owner_user_id: ownerUserId, survivor_id: personId } = merges[0];

    const outcome = await this.dataSource.transaction(async (em) => {
      // The bag as it is now, locked: an edit or a merge that commits meanwhile
      // is folded into, not overwritten.
      const [row]: Array<{ properties: unknown }> = await em.query(
        `SELECT properties FROM ci.entities
          WHERE owner_user_id = $1 AND entity_id = $2 AND merged_into_entity_id IS NULL
          FOR UPDATE`,
        [ownerUserId, personId],
      );
      // Merged into someone else since the read: left unflagged, so the next
      // run finds these merges again through that person.
      if (!row) {
        return null;
      }

      const current = row.properties ?? {};

      // A bag that is not an object is left for a human, as the identity-list
      // repair leaves it: unflagged, so the addresses come back on the first
      // start after someone fixes the bag.
      if (typeof current !== 'object' || Array.isArray(current)) {
        this.logger.warn('Left the addresses merged into a person alone: its properties are not an object', {
          ownerUserId,
          personId,
        });

        return null;
      }

      // Read here, not with the merges: one person's bags in memory at a time,
      // and each tombstone as it stands now rather than at the first read.
      const bags: MergeBags[] = await em.query(
        `SELECT m.merge_id,
                m.details -> 'sourceProperties' AS snapshot,
                source.properties               AS tombstone
           FROM ci.entity_merges m
           JOIN ci.entities source
             ON source.entity_id = m.source_entity_id
            AND source.owner_user_id = m.owner_user_id
          WHERE m.owner_user_id = $1 AND m.merge_id = ANY($2::uuid[])`,
        [ownerUserId, merges.map((merge) => merge.merge_id)],
      );
      const bagsOf = new Map(bags.map((bag) => [bag.merge_id, bag]));

      // A merge reached through a hop went into a row that was itself merged
      // in later, and an address removed by hand on that row is as removed.
      const people = [...new Set([personId, ...merges.map((merge) => merge.target_id)])];
      const edits = await this.addressEdits(em, ownerUserId, people, merges[0].created_at);
      let leftOff = 0;

      const sources = merges.map((merge) => {
        const bag = bagsOf.get(merge.merge_id);

        if (!bag || typeof bag.snapshot !== 'object' || bag.snapshot === null) {
          return {};
        }

        const removed = removedByHand(
          edits.filter((edit) => edit.changed_at > merge.created_at),
          flatAddressOf(bag.snapshot),
        );
        const offered = offeredAddresses(bag.snapshot, bag.tombstone ?? {}, removed);
        leftOff += offered.leftOff;

        return offered.bag;
      });

      const before = current as Record<string, unknown>;
      const after = withFoldedAddresses(before, sources);

      if (after) {
        await em.query(
          `UPDATE ci.entities SET properties = $3::jsonb, updated_at = now()
            WHERE owner_user_id = $1 AND entity_id = $2`,
          [ownerUserId, personId, JSON.stringify(after)],
        );

        await this.graphDeltaWriter.record({
          nodeType: 'entity',
          changeType: 'updated',
          entityId: personId,
          entityType: 'Person',
          ownerUserId,
          changedFields: changedFieldsBetween(before, after, ADDRESS_KEYS),
          changeSource: 'MergedAddressRepairService.repair',
          changeReason: 'Addresses of a person merged into this one, which the merge had dropped',
          changedByUserId: ownerUserId,
          manager: em,
        });
      }

      const changed = after != null;

      await em.query(
        `UPDATE ci.entity_merges
            SET details = details || jsonb_build_object($3::text, true)
          WHERE owner_user_id = $1 AND merge_id = ANY($2::uuid[])`,
        [ownerUserId, merges.map((merge) => merge.merge_id), ADDRESSES_FOLDED],
      );

      return { changed, leftOff };
    });

    if (!outcome) {
      return { changed: false, leftOff: 0, flagged: 0 };
    }

    if (outcome.changed) {
      this.logger.log('Put back addresses merged into a person', {
        ownerUserId,
        personId,
        merges: merges.length,
        leftOff: outcome.leftOff,
      });

      // Re-index, as a merge does: the search row reads the properties bag.
      // The addresses are committed and the merges flagged by now, so a send
      // that fails is logged as itself, not as a repair that did not happen.
      try {
        await this.eventService.send(PersonUpdatedEvent, { personId });
      } catch (err) {
        this.logger.warn('Could not re-index a person whose merged addresses were put back', {
          err,
          ownerUserId,
          personId,
        });
      }
    }

    return { ...outcome, flagged: merges.length };
  }

  /** The address edits in the app of any of `personIds` since `since`, oldest first. */
  private async addressEdits(
    em: EntityManager,
    ownerUserId: string,
    personIds: string[],
    since: Date,
  ): Promise<AddressEdit[]> {
    return em.query(
      `SELECT changed_at, changed_fields
         FROM ci.graph_deltas
        WHERE owner_user_id = $1
          AND entity_id = ANY($2::uuid[])
          AND node_type = 'entity'
          AND change_type = 'updated'
          AND change_source LIKE 'PersonService.%'
          AND changed_at > $3
          AND changed_fields ?| $4::text[]
        ORDER BY changed_at`,
      [ownerUserId, personIds, since, [...ADDRESS_KEYS]],
    );
  }
}

/**
 * Whether an address was removed by one of `edits`: on the old side of an
 * edit's address list and not on its new side, or, for an edit through the
 * flat fields, `shown` (the one address an older merge put in the flat fields,
 * the only one the person could edit there) when the old value of every flat
 * part the edit changed describes it.
 */
export function removedByHand(
  edits: AddressEdit[],
  shown: PersonAddress | null = null,
): (address: PersonAddress) => boolean {
  const removedKeys = new Set<string>();
  const flatEdits: Array<Array<readonly [keyof PersonAddress, string | null]>> = [];

  for (const { changed_fields: fields } of edits) {
    const list = fields.addresses;
    if (list) {
      const kept = new Set(readPersonAddresses({ addresses: list.new }).map(addressKey));
      for (const address of readPersonAddresses({ addresses: list.old })) {
        if (!kept.has(addressKey(address))) {
          removedKeys.add(addressKey(address));
        }
      }
    }

    const parts = FLAT_ADDRESS_PARTS.filter(([key]) => fields[key] != null).map(
      ([key, part]) =>
        [part, typeof fields[key]?.old === 'string' ? (fields[key].old as string) : null] as const,
    );
    if (parts.some(([, old]) => old != null && old.trim() !== '')) {
      flatEdits.push(parts);
    }
  }

  const same = (a: unknown, b: string | null) =>
    (typeof a === 'string' ? a : '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

  if (shown != null && flatEdits.some((parts) => parts.every(([part, old]) => same(shown[part], old)))) {
    removedKeys.add(addressKey(shown));
  }

  return (address) => removedKeys.has(addressKey(address));
}

/** The address a person's flat address keys describe, as an older merge copied them across. */
export function flatAddressOf(properties: Record<string, unknown>): PersonAddress | null {
  const flat = Object.fromEntries(
    PERSON_ADDRESS_MIRROR_KEYS.filter((key) => key in properties).map((key) => [key, properties[key]]),
  );

  return readPersonAddresses(flat)[0] ?? null;
}

/**
 * The source's address keys as a merge would read them, less what may not come
 * back: an address its tombstone no longer holds, or one the person removed by
 * hand after the merge. The flat keys stand for an address only when the list
 * holds none (as {@link readPersonAddresses} reads them).
 */
export function offeredAddresses(
  snapshot: Record<string, unknown>,
  tombstone: Record<string, unknown>,
  removed: (address: PersonAddress) => boolean,
): { bag: Record<string, unknown>; leftOff: number } {
  const held = new Set(readPersonAddresses(tombstone).map(addressKey));
  const tombstoneList = tombstone.addresses;
  const heldEntries = new Set(
    (Array.isArray(tombstoneList) ? tombstoneList : tombstoneList != null ? [tombstoneList] : []).map(
      (entry) => stableJson(entry),
    ),
  );
  let leftOff = 0;

  const offered = (address: PersonAddress): boolean => {
    if (!held.has(addressKey(address))) {
      return false;
    }

    if (removed(address)) {
      leftOff += 1;

      return false;
    }

    return true;
  };

  // Each readable entry on its own terms; anything else (another importer's
  // shape) only if the tombstone still holds it.
  const keepEntry = (entry: unknown): boolean => {
    const address = readStoredPersonAddress(entry);

    return address ? offered(address) : heldEntries.has(stableJson(entry));
  };

  const bag: Record<string, unknown> = {};
  if (snapshot[USER_EDITED_KEYS] !== undefined) {
    bag[USER_EDITED_KEYS] = snapshot[USER_EDITED_KEYS];
  }

  const list = snapshot.addresses;
  if (Array.isArray(list)) {
    bag.addresses = list.filter(keepEntry);
  } else if (list != null && heldEntries.has(stableJson(list))) {
    // A lone value in place of the list is not read as an address (see
    // readPersonAddresses), and the fold carries it whole as an entry it cannot
    // read, so it comes back on the same terms as one.
    bag.addresses = list;
  }

  const listIsRead = Array.isArray(list) && list.some((entry) => readStoredPersonAddress(entry) != null);
  if (!listIsRead) {
    const legacy = flatAddressOf(snapshot);

    if (legacy && offered(legacy)) {
      for (const key of PERSON_ADDRESS_MIRROR_KEYS) {
        if (key in snapshot) {
          bag[key] = snapshot[key];
        }
      }
    }
  }

  return { bag, leftOff };
}
