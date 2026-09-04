import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { UserServiceContext } from '@ci/common/context';

import { AttachmentFileLoader } from '../AttachmentFileLoader';
import { ConnectionLoader } from '../ConnectionLoader';
import { ContentFileLoader } from '../ContentFileLoader';
import { ContentLoader } from '../ContentLoader';
import { EventContentsLoader } from '../EventContentsLoader';
import { EventLoader } from '../EventLoader';
import { EventMediaLoader } from '../EventMediaLoader';
import { FileItemsLoader } from '../FileItemsLoader';
import { ItemAcquisitionLoader, ReceiptLineItemsLoader } from '../ItemAcquisitionLoader';
import { ItemFileLoader } from '../ItemFileLoader';
import { ItemIdentifierLoader, ProductIdentifierLoader } from '../ItemIdentifierLoader';
import { ItemObservationLoader } from '../ItemObservationLoader';
import { ItemProductLoader } from '../ItemProductLoader';
import { PersonIdentifiersLoader } from '../PersonIdentifiersLoader';
import { PersonInteractionStatsLoader } from '../PersonInteractionStatsLoader';
import { PersonLoader } from '../PersonLoader';
import { PlaceLoader } from '../PlaceLoader';
import { PlaceVisitStatsLoader } from '../PlaceVisitStatsLoader';
import { PreviewLoader } from '../PreviewLoader';
import { ProviderKeyLoader } from '../ProviderKeyLoader';
import { ProviderLoader } from '../ProviderLoader';
import { QuestionLoader } from '../QuestionLoader';
import { TagAssignmentCountLoader } from '../TagAssignmentCountLoader';
import { TagLoader } from '../TagLoader';
import { ThreadLoader } from '../ThreadLoader';
import { ThreadMessagesLoader } from '../ThreadMessagesLoader';
import { UnfurlLoader } from '../UnfurlLoader';

/**
 * ONE contract, held against every loader in this directory:
 *
 *   `batchLoad` returns exactly `keys.length` values, IN KEY ORDER, with the
 *   empty value for a key that has no row.
 *
 * DataLoader hands entry `i` to whoever asked for key `i`. A collaborator that
 * returns "the set of matching rows" instead of "one per key, in key order"
 * therefore hands each caller somebody else's row — silently, correctly-shaped,
 * and only once a page holds more than one of them. That is what captioned five
 * real answers on this appliance with four other answers' questions: "I follow
 * hockey." under "What city were you born in?".
 *
 * The four loaders that were hand-checked at the time all happened to be fine,
 * which is the problem — inspection does not stay true. So every loader here is
 * driven through a collaborator that does what a `WHERE id IN (...)` read
 * actually does: it hands back its rows REVERSED, and, in the second scenario,
 * silently short one id. A loader that re-keys survives both. A loader that
 * passes its collaborator's result straight through fails the first on the
 * values and the second on the length.
 *
 * `covers every loader in the directory` below fails when a new loader is added
 * without a case, so this cannot quietly go back to being a partial check.
 */

const CTX = { userId: 'user-1' } as UserServiceContext;

/** The page's keys, in the order the resolvers ask for them. */
const KEYS = ['id-a', 'id-b', 'id-c'] as const;

/** Every key has a row. */
const ALL: ReadonlySet<string> = new Set(KEYS);

/**
 * The middle key has no row — deleted, or private to another user. A hole is
 * the nastier half of the bug: positional zipping shifts every LATER key onto
 * its neighbour's row, so a mispairing shows up on both sides of the gap.
 */
const HOLE: ReadonlySet<string> = new Set(['id-a', 'id-c']);

/** Distinct per key, so a scalar-valued loader's mispairing is visible too. */
const COUNT: Record<string, number> = { 'id-a': 11, 'id-b': 22, 'id-c': 33 };

const LOGGER = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
};

/** A hand-built stand-in for one of a loader's constructor arguments. */
function stub<T>(value: object): T {
  return value as unknown as T;
}

/**
 * What `WHERE ... IN (:...ids)` hands back: the matching rows only, in an order
 * of the planner's choosing. Reversed here because reversal is the cheapest
 * order that is wrong for every key at once.
 */
function planner<T>(ids: readonly string[], present: ReadonlySet<string>, row: (id: string) => T): T[] {
  return ids
    .filter((id) => present.has(id))
    .map(row)
    .reverse();
}

/**
 * The same thing for a collaborator that returns a keyed map. A map cannot
 * mispair by position, but it CAN be iterated instead of indexed, so its
 * insertion order is reversed too — `[...map.values()]` fails this, `map.get()`
 * does not.
 */
function plannerMap<T>(
  ids: readonly string[],
  present: ReadonlySet<string>,
  row: (id: string) => T,
): Map<string, T> {
  return new Map(planner(ids, present, (id) => [id, row(id)] as const));
}

interface LoaderCase {
  /** Class name, matched against the directory listing. */
  name: string;
  /** Builds the loader over stubs holding rows for exactly `present`. */
  build(present: ReadonlySet<string>): (id: string) => Promise<unknown>;
  /** The identifying marker carried by a loaded value — the key it belongs to. */
  probe(value: unknown): unknown;
  /** What `probe` yields for a key the loader found nothing for. */
  empty: unknown;
  /** Overrides `probe`'s expected value for a key that DOES have a row. */
  found?(id: string): unknown;
}

/** `.id` is the marker for the single-row loaders. */
const probeId = (value: unknown): unknown => (value as { id: string } | null)?.id ?? null;

/** …and the joined ids for the list-valued ones, so a spilled list is visible. */
const probeIds = (value: unknown): unknown =>
  (value as { id: string }[]).map((row) => row.id).join(',') || null;

const CASES: readonly LoaderCase[] = [
  {
    name: 'AttachmentFileLoader',
    build: (present) => {
      const loader = new AttachmentFileLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id, url: id })),
          findVariantsByParentIds: async (_ctx: unknown, ids: string[]) =>
            planner(ids, present, (id) => ({ id: `pv-${id}`, parentId: id, url: `pv:${id}` })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: (value) => (value as { url: string } | null)?.url ?? null,
    empty: null,
  },
  {
    name: 'ConnectionLoader',
    build: (present) => {
      const loader = new ConnectionLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'ContentFileLoader',
    build: (present) => {
      const loader = new ContentFileLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id, url: id })),
          findVariantsByParentIds: async (_ctx: unknown, ids: string[]) =>
            planner(ids, present, (id) => ({ id: `pv-${id}`, parentId: id, url: `pv:${id}` })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: (value) => (value as { mediaUrl: string } | null)?.mediaUrl ?? null,
    empty: null,
  },
  {
    name: 'ContentLoader',
    build: (present) => {
      const loader = new ContentLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'EventContentsLoader',
    build: (present) => {
      const loader = new EventContentsLoader(
        stub({
          findByEventIds: async (_ctx: unknown, ids: string[]) => plannerMap(ids, present, (id) => [{ id }]),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'EventLoader',
    build: (present) => {
      const loader = new EventLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'EventMediaLoader',
    build: (present) => {
      const loader = new EventMediaLoader(
        stub({
          // event -> content link. The file id is derived from the event id so
          // the walk's second hop can be scrambled independently of the first.
          findMediaFilesByEventIds: async (_ctx: unknown, ids: string[]) =>
            planner(ids, present, (id) => ({ eventId: id, fileId: `file-of-${id}`, mimetype: null })),
        }),
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) =>
            ids.map((id) => ({ id, url: id.replace('file-of-', '') })).reverse(),
          findVariantsByParentIds: async (_ctx: unknown, ids: string[]) =>
            ids.map((id) => ({ id: `pv-${id}`, parentId: id, url: `pv:${id}` })).reverse(),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: (value) => (value as { mediaUrl: string } | null)?.mediaUrl ?? null,
    empty: null,
  },
  {
    name: 'FileItemsLoader',
    build: (present) => {
      const loader = new FileItemsLoader(
        stub({
          findByFileIds: async (_ctx: unknown, ids: string[]) => plannerMap(ids, present, (id) => [{ id }]),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'ItemAcquisitionLoader',
    build: (present) => {
      const loader = new ItemAcquisitionLoader(
        // A repository `find` answers the whole `In (...)` at once, so the stub
        // ignores the where clause and hands back the batch's rows directly.
        stub({ find: async () => planner(KEYS, present, (id) => ({ id })) }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'ReceiptLineItemsLoader',
    build: (present) => {
      const loader = new ReceiptLineItemsLoader(
        stub({ find: async () => planner(KEYS, present, (id) => ({ id, receiptId: id })) }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'ItemFileLoader',
    build: (present) => {
      const loader = new ItemFileLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'ItemIdentifierLoader',
    build: (present) => {
      const loader = new ItemIdentifierLoader(
        stub({
          listForSubjects: async (_userId: string, _subject: string, ids: string[]) =>
            plannerMap(ids, present, (id) => [{ id }]),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'ProductIdentifierLoader',
    build: (present) => {
      const loader = new ProductIdentifierLoader(
        stub({
          listForSubjects: async (_userId: string, _subject: string, ids: string[]) =>
            plannerMap(ids, present, (id) => [{ id }]),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'ItemObservationLoader',
    build: (present) => {
      const loader = new ItemObservationLoader(
        stub({ find: async () => planner(KEYS, present, (id) => ({ id, resolvedObjectId: id })) }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'ItemProductLoader',
    build: (present) => {
      const loader = new ItemProductLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'PersonIdentifiersLoader',
    build: (present) => {
      const loader = new PersonIdentifiersLoader(
        stub({
          listForEntities: async (_userId: string, ids: string[]) =>
            plannerMap(ids, present, (id) => [{ id }]),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'PersonInteractionStatsLoader',
    build: (present) => {
      const loader = new PersonInteractionStatsLoader(
        stub({
          getInteractionStats: async (_ctx: unknown, ids: string[]) =>
            plannerMap(ids, present, (id) => ({
              eventCount: COUNT[id],
              communicationCount: COUNT[id],
              lastInteractionAt: null,
            })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: (value) => (value as { communicationCount: number }).communicationCount,
    found: (id) => COUNT[id],
    empty: 0,
  },
  {
    name: 'PersonLoader',
    build: (present) => {
      const loader = new PersonLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'PlaceLoader',
    build: (present) => {
      const loader = new PlaceLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'PlaceVisitStatsLoader',
    build: (present) => {
      const loader = new PlaceVisitStatsLoader(
        stub({
          getVisitStats: async (_ctx: unknown, ids: string[]) =>
            plannerMap(ids, present, (id) => ({
              visitCount: COUNT[id],
              firstVisitAt: null,
              lastVisitAt: null,
              status: 'confirmed',
            })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: (value) => (value as { visitCount: number }).visitCount,
    found: (id) => COUNT[id],
    empty: 0,
  },
  {
    name: 'PreviewLoader',
    build: (present) => {
      const loader = new PreviewLoader(
        stub({
          // Keyed on the ORIGINAL, so the marker is `parentId`, not `id`.
          findVariantsByParentIds: async (_ctx: unknown, ids: string[]) =>
            planner(ids, present, (id) => ({ id: `pv-${id}`, parentId: id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: (value) => (value as { parentId: string } | null)?.parentId ?? null,
    empty: null,
  },
  {
    name: 'ProviderKeyLoader',
    build: (present) => {
      const loader = new ProviderKeyLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'ProviderLoader',
    build: (present) => {
      const loader = new ProviderLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'QuestionLoader',
    build: (present) => {
      const loader = new QuestionLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'TagAssignmentCountLoader',
    build: (present) => {
      const loader = new TagAssignmentCountLoader(
        stub({
          getAssignmentCounts: async (_ctx: unknown, ids: string[]) =>
            plannerMap(ids, present, (id) => COUNT[id]),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: (value) => value,
    found: (id) => COUNT[id],
    empty: 0,
  },
  {
    name: 'TagLoader',
    build: (present) => {
      const loader = new TagLoader(
        stub({
          // Keyed by the identifier OBJECT the caller passed in, which is what
          // the real TagService does — so the stub must key on the same refs.
          getTagsForEntities: async (_ctx: unknown, entityIds: { id: string }[]) => {
            const byRef = new Map<{ id: string }, { id: string }[]>();

            for (const entityId of [...entityIds].reverse()) {
              if (present.has(entityId.id)) {
                byRef.set(entityId, [{ id: entityId.id }]);
              }
            }

            return byRef;
          },
        }),
        stub(LOGGER),
      );

      // The key is `{ id, type }`, one stable object per id so DataLoader's
      // identity cache behaves as it does behind a resolver.
      const keys = new Map(KEYS.map((id) => [id as string, { id, type: 'event' }]));

      return (id) => loader.load(CTX, stub(keys.get(id)!));
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'ThreadLoader',
    build: (present) => {
      const loader = new ThreadLoader(
        stub({
          findByIds: async (_ctx: unknown, ids: string[]) => planner(ids, present, (id) => ({ id })),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeId,
    empty: null,
  },
  {
    name: 'ThreadMessagesLoader',
    build: (present) => {
      const loader = new ThreadMessagesLoader(
        stub({
          findByThreadIds: async (_ctx: unknown, ids: string[]) => plannerMap(ids, present, (id) => [{ id }]),
        }),
        stub(LOGGER),
      );

      return (id) => loader.load(CTX, id);
    },
    probe: probeIds,
    empty: null,
  },
  {
    name: 'UnfurlLoader',
    build: (present) => {
      const loader = new UnfurlLoader(
        stub({
          findByKeys: async (_ctx: unknown, keys: string[]) =>
            plannerMap(keys, present, (key) => ({
              status: 'ok',
              resolver: 'test',
              posterFileId: `poster-${key}`,
              // Loses to the cached local copy — and names the bug if it wins.
              thumbnailUrl: `remote:${key}`,
              payload: null,
              fetchedAt: null,
            })),
        }),
        stub({
          // Rotated rather than reversed: this is the second reversal in the
          // walk, and two of them cancel — a positional zip would come back
          // round to the right answer and the mutation would go unnoticed.
          findByIds: async (_ctx: unknown, ids: string[]) => {
            const files = ids.map((id) => ({ id, url: id.replace('poster-', '') }));

            return [...files.slice(1), ...files.slice(0, 1)];
          },
        }),
        stub(LOGGER),
      );

      return (key) => loader.load(CTX, key);
    },
    probe: (value) => (value as { thumbnailUrl: string } | null)?.thumbnailUrl ?? null,
    empty: null,
  },
];

function expectedFor(loaderCase: LoaderCase, id: string, present: ReadonlySet<string>): unknown {
  if (!present.has(id)) {
    return loaderCase.empty;
  }

  return loaderCase.found ? loaderCase.found(id) : id;
}

async function probeAll(loaderCase: LoaderCase, present: ReadonlySet<string>): Promise<unknown[]> {
  const load = loaderCase.build(present);

  // One tick, so all three keys land in a single batch — the only situation in
  // which a mispairing can happen at all.
  const values = await Promise.all(KEYS.map((id) => load(id)));

  return values.map((value) => loaderCase.probe(value));
}

describe.each(CASES.map((loaderCase) => [loaderCase.name, loaderCase] as const))(
  '%s batch contract',
  (_name, loaderCase) => {
    it('gives every key its own row when the rows come back out of order', async () => {
      await expect(probeAll(loaderCase, ALL)).resolves.toEqual(
        KEYS.map((id) => expectedFor(loaderCase, id, ALL)),
      );
    });

    it('gives a key with no row the empty value, without shifting any other key', async () => {
      await expect(probeAll(loaderCase, HOLE)).resolves.toEqual(
        KEYS.map((id) => expectedFor(loaderCase, id, HOLE)),
      );
    });
  },
);

describe('the case table', () => {
  it('covers every loader in the directory', () => {
    const directory = join(__dirname, '..');

    const declared = readdirSync(directory)
      .filter((file) => file.endsWith('.ts') && file !== 'Loader.ts')
      .flatMap((file) => [
        ...readFileSync(join(directory, file), 'utf8').matchAll(/export class (\w+) extends Loader</g),
      ])
      .map((match) => match[1])
      .sort();

    expect(declared).toEqual(CASES.map((loaderCase) => loaderCase.name).sort());
  });
});
