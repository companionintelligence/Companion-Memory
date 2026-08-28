/*
 * Test-facing views of the importer output types.
 *
 * The production `Graph`/`Item` types in ../../timeline make nearly every field
 * optional, because a graph is assembled incrementally as an importer walks an
 * export. By the time a test inspects one it has already been pushed to the
 * pipeline, so the fields the test asserts on are present by construction.
 *
 * Without these aliases the collectors were typed `any[]` — which is how they
 * arrived from the standalone importer, where test files were excluded from
 * typechecking. Naming the post-conditions instead keeps the collectors typed
 * and still lets a test read `g.item.metadata.Title` without a `!` per hop.
 *
 * These are assertions about test data, not about production behavior: nothing
 * here widens what an importer is allowed to emit.
 */
import type {
  Entity,
  Graph,
  Item,
  ImportPipeline,
  ItemData,
  MediaAttachment,
  Metadata,
  MetadataValue,
} from '../../timeline';

/** An item that has been emitted: its metadata and content bags exist. */
export interface EmittedItem extends Omit<Item, 'metadata' | 'content'> {
  metadata: Metadata;
  content: ItemData;
}

/**
 * A graph as collected from a test pipeline. `item` is non-optional because the
 * overwhelming majority of importers emit item-bearing graphs and the tests
 * index straight into them; `entity` and `edges` stay optional, matching the
 * production type, so entity-only graphs still read correctly.
 */
export interface EmittedGraph extends Omit<Graph, 'item'> {
  item: EmittedItem;
}

/** A graph collected from an importer that emits entities (contacts, vCards). */
export interface EmittedEntityGraph extends Omit<Graph, 'entity'> {
  entity: Entity;
}

/**
 * Read a metadata value the test expects to be text.
 *
 * `MetadataValue` is a wide union (dates, arrays, attachment lists), so string
 * operations on a bag entry don't typecheck. These readers state which member
 * the assertion is about instead of casting at every call site.
 */
export function metaText(value: MetadataValue): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

/** Read a metadata value the test expects to be an attachment list. */
export function metaAttachments(value: MetadataValue): MediaAttachment[] {
  return Array.isArray(value) ? (value as MediaAttachment[]) : [];
}

/**
 * The value tests pass as `ImportParams['pipeline']`.
 *
 * An array already satisfies the `push(g)` half of ImportPipeline, which is why
 * the tests hand one straight in. Some also attach a `drop` or `consumed` sink
 * afterwards to observe the importer's drop ledger / records-read count; this
 * alias names that shape so doing so doesn't need a cast through `any`.
 */
export type TestPipeline = EmittedGraph[] & Pick<ImportPipeline, 'drop' | 'consumed'>;
