export const INDEXABLE_ENTITIES = [
  'answer',
  'browser-activity',
  'communication',
  'concept',
  'content',
  'event',
  'file',
  'file-chunk',
  'item',
  // Raw conversation fragments, embedded for the recall "naive RAG" channel.
  // Surfaced ONLY via SearchService.searchMessages; entity/graph searches
  // exclude this type so the two retrieval channels stay separate.
  'message',
  'note',
  'person',
  'place',
  'position',
  // Catalog models (ci.product_models) and purchase evidence (ci.receipts).
  // Indexed as first-class types so "my Bose QC45" finds the model even when no
  // owned unit carries the brand words, and "the Home Depot receipt from March"
  // finds the evidence rather than only the things minted off it.
  'product',
  'receipt',
  // Planning work items (ci.tasks). Indexed so "what am I supposed to be doing
  // about the Fenwick contract?" answers from the planner without a tool call —
  // the stated reason planning lives in CI-Server at all
  // (docs/architecture/planning-roadmap.md:14). Planned blocks are deliberately
  // NOT indexed: the task carries the words, the block only carries a time.
  'task',
  'thread',
] as const;

export type IndexableEntity = (typeof INDEXABLE_ENTITIES)[number];

/**
 * The indexed types a device carries a plain-text copy of (`ci_search.mobile_search_documents`,
 * replicated by PowerSync and searched on the phone with FTS5). The subset of
 * {@link INDEXABLE_ENTITIES} minus `answer` and `position` (no text of their own
 * worth a row) and `message` (the chat recall channel, excluded from entity
 * search everywhere else too).
 *
 * `browser-activity` and `file-chunk` joined on 2026-10-23. Both were left out
 * at first because the header box hides them from its suggestions, but the
 * Memory list and the explorer's filters show them on the appliance, and a
 * phrase from inside a parsed PDF only finds the file through its chunks:
 * the file's own record carries title, description and filename, nothing of
 * the body. A chunk's record points at its file through `related_id`.
 */
export const DEVICE_INDEXED_ENTITIES = [
  'browser-activity',
  'communication',
  'concept',
  'content',
  'event',
  'file',
  'file-chunk',
  'item',
  'note',
  'person',
  'place',
  'product',
  'receipt',
  'task',
  'thread',
] as const satisfies readonly IndexableEntity[];

export type DeviceIndexedEntity = (typeof DEVICE_INDEXED_ENTITIES)[number];

export const TAGGABLE_ENTITIES = [
  'action',
  'browser-activity',
  'communication',
  'concept',
  'content',
  'event',
  'file',
  'item',
  'note',
  'person',
  'place',
  'product',
  'receipt',
  // Planning work items. Tags are how a task inherits a direction and the
  // life-balance categories that placement and balance bias read, so tasks
  // must share the one tag vocabulary rather than growing a parallel one.
  'task',
  'thread',
] as const;

export type TaggableEntity = (typeof TAGGABLE_ENTITIES)[number];

/**
 * The taxonomy LEVEL a tag sits at (`ci_search.tags.kind`) -- orthogonal to
 * `entity_tag.level`, which is a per-*entity* dilution weight and has nothing
 * to do with this. A 'direction' is a top-level, brand-set grouping
 * (Home/Work/Community, `is_base`); an 'intention' groups under 0+
 * directions via `tag_directions`; a 'category' is a SECOND, orthogonal
 * grouping over intentions via `tag_categories`, with its own per-direction
 * opt-outs. `null` (untyped) is the state of every tag that predates this
 * column.
 */
export const TAG_KINDS = ['direction', 'intention', 'category'] as const;

export type TagKind = (typeof TAG_KINDS)[number];

export interface EntityIdentifier<T> {
  type: T;
  id: string;
  /**
   * Optional sort key the browse used for this identifier. People/places
   * date-filter by first real activity in the window (`appeared_at`), not
   * `created_at`. SearchResolver stamps it onto the resolved entity as
   * `appearedAt` so the cursor and GraphQL field match the SQL order.
   */
  sortTime?: Date;
}

export interface CreateTagDto {
  id?: string;
  label: string;
  description?: string;
  forUserId?: string;
}

export interface UpdateTagDto {
  label?: string;
  /** `null` clears the description; omit the key to leave it as it is. */
  description?: string | null;
}

export interface TagEntitiesDto {
  labels: string[];
  forUserId?: string;
  entities: EntityIdentifier<TaggableEntity>[];
}

export type SearchResult = {
  type: IndexableEntity;
  id: string;
};

/**
 * The result of a prompt search, which reports HOW MANY matched as well as
 * which ones came back.
 *
 * Every other search method returns a bare array, so a caller cannot tell a set
 * that happens to be exactly `maxResults` long from one that was cut off there.
 * That distinction is invisible for an owner scrolling their own results and
 * load-bearing for an ask: the `count` disclosure rung reports a NUMBER to
 * another person, and a silently saturated 50 is a false statement about the
 * owner's life. `totalMatches` is the true size of the match set;
 * `items.length` is what fit.
 */
export interface PromptSearchResult {
  items: EntityIdentifier<IndexableEntity>[];
  /** True size of the match set, before the cap. */
  totalMatches: number;
  /** `totalMatches > items.length` — the answer is "at least", not "exactly". */
  truncated: boolean;
  /** The cap that was applied, so a caller can explain the truncation. */
  limit: number;
}
