/**
 * The CLOSED vocabulary a dropped record is counted under, and the registry
 * that maps every parser's own slug into it.
 *
 * ## Why two levels
 *
 * The parsers already emit a drop slug — `params.pipeline.drop?.('cancelled_order')`
 * — and there are 34 distinct ones across the datasource pack, minted
 * independently by whoever wrote each parser. They are useful and they must
 * stay: "78 retweets whose media we do not import" is a better sentence than
 * any category name. But they are not a vocabulary. Four different parsers
 * spell "the archive references bytes it does not contain" four ways
 * (`media_asset_missing`, `media_file_missing`, `missing_media`,
 * `whatsapp_attachment_missing`), so nothing can group them, and a new parser
 * inventing a 35th slug is indistinguishable from a typo in an existing one.
 *
 * So: the slug is kept verbatim as the human-facing detail, and every slug is
 * ALSO classified into one of the ~20 {@link DropReason} codes below, which is
 * what a caller groups and counts by. An agent asking "did this import lose
 * media?" reads `dropsByReason.media_missing` across every source in the run;
 * it does not have to know that `grok_attachment_missing` exists.
 *
 * ## Why a registry and not a rename
 *
 * Renaming 34 call sites across 20 datasource files would be a bigger, riskier
 * diff than the telemetry it serves, and it would break comparison with every
 * run already in `ci_import.import_stages` — the live QA corpus this was built
 * against has drop ledgers in it right now. Classification is additive: old
 * rows stay readable, and a slug this table does not know lands in
 * {@link UNCLASSIFIED} rather than vanishing, which is what makes a new
 * parser's new slug SHOW UP instead of being silently absorbed.
 */

/**
 * Every category a record can be lost under, appliance-wide.
 *
 * Deliberately short and snake_case: these are grouped, counted and compared
 * between runs, so they are identifiers, not prose. Adding one is a
 * deliberate act — {@link DROP_REASONS} is the list, and the vocabulary test
 * asserts the registry only maps into it.
 */
export const DROP_REASONS = [
  /** The source itself says the thing never happened — a cancelled order or trip. */
  'cancelled',
  /** Excluded on purpose by import policy: a draft, a retweet, a record outside the requested timeframe. */
  'filtered',
  /** No usable timestamp, and the destination this record wanted needs one. */
  'no_timestamp',
  /** A timestamp was present and could not be read. Distinct from `no_timestamp`: this one is a bug lead. */
  'bad_timestamp',
  /** Nothing to name or key the record by — an unnamed product, a contact card with no fields. */
  'no_identity',
  /** Parsed cleanly and came out empty. */
  'empty_record',
  /** A shape this build recognizes but has no home for. */
  'unsupported_shape',
  /** The file could not be read or did not parse. */
  'unreadable_source',
  /** The record names bytes the archive does not actually contain. */
  'media_missing',
  /** The bytes are there and are not a form this appliance stores. */
  'media_unsupported',
  /** The bytes are there, are storable, and the object store refused them. */
  'media_store_failed',
  /**
   * Collapsed onto a row this run already staged, with identity PROVEN — the
   * same photo replicated into three album folders. Expected, not a loss.
   */
  'duplicate_in_run',
  /**
   * Collapsed onto a row this run already staged WITHOUT proving they are the
   * same thing. This one is a genuine loss and reads as expected dedup unless
   * it is counted apart — see StagedWriter.recordCollapse.
   */
  'collapsed_ambiguous',
  /** The destination already held this record. The push's honest re-import outcome. */
  'already_present',
  /** Routing produced no destination at all — the record was never offered to anything. */
  'no_destination',
  /** An exception quarantined this one row; the rest of the batch went. */
  'row_failed',
  /** An entity with neither a handle nor a name. It will not resolve on a retry either. */
  'entity_unresolved',
  /** A bookkeeping entity type excluded by design (an `email_thread` per gmail thread). */
  'entity_excluded',
  /** An archive that could not be expanded, so everything inside it is absent. */
  'archive_rejected',
  /**
   * The stage stopped before it reached these records — a push that ran out of
   * disk, a stage summarized mid-flight. Nothing is wrong with the records;
   * they are still `pending` and a resume will take them. A gap, because a
   * COMPLETED stage that leaves any is a defect.
   */
  'not_attempted',
  /** A slug this registry does not know. Present so a new one is visible rather than absorbed. */
  'unclassified',
] as const;

export type DropReason = (typeof DROP_REASONS)[number];

/** The bucket for a slug with no registry entry. See the module comment. */
export const UNCLASSIFIED: DropReason = 'unclassified';

/**
 * Whether a category is an EXPECTED outcome of a healthy import or a GAP
 * somebody should look at.
 *
 * The distinction is the whole point of the ledger. A run that dropped 40,000
 * records under `filtered` and `already_present` is a run that worked; a run
 * that dropped 12 under `collapsed_ambiguous` lost twelve things nobody can
 * name. Reporting one number for both is how the second hides inside the
 * first — which is exactly what `deduped` did on the push stage before this.
 */
export type DropSeverity = 'expected' | 'gap';

const DROP_SEVERITY: Readonly<Record<DropReason, DropSeverity>> = {
  cancelled: 'expected',
  filtered: 'expected',
  duplicate_in_run: 'expected',
  already_present: 'expected',
  entity_excluded: 'expected',
  // Everything below here means the appliance was handed something it could
  // not turn into a memory. Some are the export's fault and some are ours;
  // both are worth a person's attention, and neither should be summed into a
  // number labelled "deduped".
  no_timestamp: 'gap',
  bad_timestamp: 'gap',
  no_identity: 'gap',
  empty_record: 'gap',
  unsupported_shape: 'gap',
  unreadable_source: 'gap',
  media_missing: 'gap',
  media_unsupported: 'gap',
  media_store_failed: 'gap',
  collapsed_ambiguous: 'gap',
  no_destination: 'gap',
  row_failed: 'gap',
  entity_unresolved: 'gap',
  archive_rejected: 'gap',
  not_attempted: 'gap',
  unclassified: 'gap',
};

/**
 * Every drop slug the datasource pack emits, mapped to its category.
 *
 * Sorted by slug. Kept exhaustive by a test that walks `datasources/` for
 * `drop?.('...')` literals and fails on one this table has not classified —
 * so adding a parser with a new slug is a one-line change here rather than a
 * silent `unclassified` in production telemetry.
 */
export const DROP_SLUG_REASONS: Readonly<Record<string, DropReason>> = {
  // Playback the source recorded and the user never really had: a trailer that
  // auto-played, a title abandoned in the first seconds.
  abandoned_playback: 'filtered',
  promo_playback: 'filtered',
  // Spotify's own skip signal: under a second of `ms_played` on an
  // end-of-play/streaming-history row.
  sub_second_play: 'filtered',

  // Deliberate policy exclusions.
  bulk_filtered: 'filtered',
  draft: 'filtered',
  excluded_reply: 'filtered',
  excluded_retweet: 'filtered',
  outside_timeframe: 'filtered',
  macos_unsupported_stream: 'unsupported_shape',
  non_message: 'filtered',
  // telegram.ts: a chat entry whose `type` is not 'message' (a service event —
  // "X joined the group", a call log) — the telegram-specific spelling of the
  // same exclusion `non_message` already covers for other sources.
  non_message_type: 'filtered',
  // mastodon.ts: an ActivityPub activity whose `type` is not 'Create' — a boost
  // ("Announce") or other activity kind, not an original post. Same policy as
  // excluded_retweet.
  non_create_activity: 'filtered',
  // mastodon.ts: a Create activity whose `object.type` is not 'Note' — a poll
  // or other non-post object this build does not treat as a status.
  non_note_object: 'filtered',
  // A line WhatsApp wrote itself — "X added you", "Y left" — recognised by its
  // U+200E marker plus the system-verb pattern. Policy, not a failure: the
  // conversation is the user's, the announcement around it is not.
  whatsapp_system_line: 'filtered',
  // A Grok turn with an attachment but no text — an image-only generation,
  // not a loss. The attachment itself is what this row actually contains,
  // and it accounts for itself via its own drop/push.
  grok_media_only_turn: 'filtered',

  // The source says it did not happen.
  cancelled_order: 'cancelled',
  cancelled_trip: 'cancelled',
  // A line with zero quantity AND zero total — an order line that never shipped.
  unfulfilled_line: 'cancelled',
  // instagram.ts: a message the sender unsent before it synced — Instagram's own
  // `is_unsent` flag. The source itself says the message no longer exists.
  unsent_message: 'cancelled',

  // Parsed and empty.
  empty_after_parse: 'empty_record',
  empty_card: 'empty_record',
  // A Robinhood row with a blank "Trans Code" — a running-total/footer row the
  // export appends, never an actual transaction.
  empty_trans_code: 'empty_record',

  // Nothing to key it by.
  unnamed_product: 'no_identity',
  // A tweets.js/tweet.js row with neither id_str nor id — the export's own
  // primary key absent from its own row.
  tweet_without_id: 'no_identity',
  // A download row whose URL chain and tab URL are both empty: ci.browser_activity
  // is keyed by url, so there is nothing to file it under.
  download_no_url: 'no_identity',
  unnamed_track: 'no_identity',
  // hulu.ts: a watch-history row carrying neither an Episode Name nor a Series
  // Name — the title is the only thing that identifies what was watched.
  no_title: 'no_identity',
  // A Connections.csv row with no First Name and no Last Name.
  unnamed_connection: 'no_identity',
  grok_unknown_sender: 'no_identity',
  // A grok-chat-item.js row with no chatId — nothing to group it under or key
  // its id by.
  grok_unknown_conversation: 'no_identity',
  note_tweet_unmatched: 'no_identity',
  // contactlist.ts: a row with fewer than 2 attributes (or 1 attribute and no
  // name) — not enough signal to be worth a Person entity.
  insufficient_attributes: 'no_identity',

  // Time.
  invalid_timestamp: 'bad_timestamp',
  position_without_time: 'no_timestamp',
  trip_without_start_time: 'no_timestamp',
  undated_retweet: 'no_timestamp',
  // A GPS sample with no fix is a row with a time and no coordinates, which is
  // the same hole in the other axis.
  position_without_fix: 'empty_record',

  // Referenced bytes that are not in the archive.
  grok_attachment_missing: 'media_missing',
  media_asset_missing: 'media_missing',
  media_file_missing: 'media_missing',
  missing_media: 'media_missing',
  whatsapp_attachment_missing: 'media_missing',
  // googlevoice.ts: a video/vCard/audio-clip MMS attachment (<a class="video"|
  // "vcard" href> or a bare <audio src>) whose referenced file resolveAttachment
  // could not find on disk. Image misses have no equivalent slug — they stay
  // silent unless recovered by the truncation-collision fallback, which is not
  // a loss and does not drop.
  googlevoice_attachment_missing: 'media_missing',

  // Bytes present, not storable / not imported.
  grok_attachment_unsupported: 'media_unsupported',
  whatsapp_attachment_unsupported: 'media_unsupported',
  retweet_media_not_imported: 'media_unsupported',

  // Shape.
  unsupported_entity_type: 'unsupported_shape',
  // A Spotify play row with none of the track/episode/audiobook fields set —
  // the source recorded a play but not what was played.
  unresolvable_playback_stub: 'unsupported_shape',
  // A Robinhood transaction row whose "Trans Code" is a real code this build
  // does not have a handler for — recognized as a transaction, not a home for it.
  unrecognized_trans_code: 'unsupported_shape',

  // Read failures.
  no_end_marker: 'unreadable_source',
  unreadable_file: 'unreadable_source',
  // contactlist.ts: a CSV row whose column count does not match the header —
  // structurally broken, not just missing a value.
  malformed_row: 'unreadable_source',
  // tiktok.ts: a JSON list entry that is not an object at all.
  malformed_entry: 'unreadable_source',
  // kindle.ts: a clipping block that did not match the export's own format.
  malformed_clip: 'unreadable_source',
  // applecontacts.ts: the AddressBook SQLite query threw partway through, so
  // every contact after the failure point was never read.
  query_failed: 'unreadable_source',

  // Minted by StagedWriter rather than a parser. Hyphenated because it predates
  // this vocabulary; classified here rather than renamed, so runs already in
  // the database stay comparable.
  'collapsed-distinct-path': 'collapsed_ambiguous',

  // ---------------------------------------------------------------------------
  // Minted by the STAGES rather than by a parser, so that a record which was
  // consumed and did not become a row is always in the ledger under a reason.
  // These are what make `consumed = produced + dropped` hold: before them,
  // `itemsDeduped` and the push's `deduped` were counters sitting outside any
  // ledger, which is precisely how a real loss hid inside an expected one.
  // ---------------------------------------------------------------------------

  /** Collapsed onto a row this run already staged, identity proven. StagedCounts.itemsDeduped. */
  duplicate_in_run: 'duplicate_in_run',
  /** A repeat sighting of an entity, merged into the row already staged. StagedCounts.entitiesGrown. */
  entity_merged: 'duplicate_in_run',
  /** PushStage: every destination for this row already held it. */
  already_in_destination: 'already_present',
  /**
   * PushStage: `destinationsFor` returned an EMPTY list, so the row was never
   * offered to anything. It was counted as `deduped` before this — see the
   * PushStage summary comment.
   */
  no_destination: 'no_destination',
  /** PushStage: the row threw and was quarantined; the batch continued. */
  row_push_failed: 'row_failed',
  /** PushStage: an entity with neither a handle nor a name to resolve by. */
  entity_unresolved: 'entity_unresolved',
  /** PushStage: a bookkeeping entity type excluded from the graph by design. */
  entity_excluded: 'entity_excluded',
  /** MediaStage: the bytes were not where the staged row said they were. */
  media_path_missing: 'media_missing',
  /** MediaStage: the staged path pointed outside the run's own scratch tree. */
  media_path_escaped_scratch: 'media_missing',
  /** MediaStage: the path resolved to something that is not a file. */
  media_not_a_file: 'media_unsupported',
  /** MediaStage: the object store refused or errored on the upload. */
  media_upload_failed: 'media_store_failed',
  /**
   * MediaStage: a message declared an attachment that carried no local path, so
   * there were no bytes to store. An iMessage row whose attachment survived the
   * export as a guid alone is the common case.
   */
  attachment_no_path: 'media_missing',
  /** MediaStage: the attachment's bytes stored, but its ci.content row did not. */
  attachment_content_failed: 'media_store_failed',
  /** UnpackStage: an archive that could not be expanded. Everything inside it is absent. */
  archive_rejected: 'archive_rejected',
  /** PushStage: rows still `pending` when the stage stopped. */
  not_yet_attempted: 'not_attempted',
};

/**
 * The category a slug counts under.
 *
 * A slug that is not in the registry returns `unclassified` — visible, and
 * therefore fixable — rather than being guessed at by prefix matching, which
 * would quietly mis-file `media_asset_missing` and `missing_media` into
 * different buckets forever.
 */
export function dropReasonFor(slug: string): DropReason {
  return DROP_SLUG_REASONS[slug] ?? UNCLASSIFIED;
}

/** Whether this category is an expected outcome or a gap worth looking at. */
export function dropSeverityFor(reason: DropReason): DropSeverity {
  return DROP_SEVERITY[reason];
}

/**
 * Roll a slug-keyed ledger up into the closed vocabulary.
 *
 * The input is `StagedCounts.drops` as the parsers produced it; the output is
 * what an agent groups by. Both are kept on the stage detail — see
 * {@link StageSummary} — because they answer different questions.
 */
export function classifyDrops(drops: Readonly<Record<string, number>>): Record<DropReason, number> {
  const byReason = {} as Record<DropReason, number>;

  for (const [slug, count] of Object.entries(drops)) {
    if (count <= 0) {
      continue;
    }

    const reason = dropReasonFor(slug);

    byReason[reason] = (byReason[reason] ?? 0) + count;
  }

  return byReason;
}

/** How many records a slug-keyed ledger accounts for. */
export function totalDrops(drops: Readonly<Record<string, number>>): number {
  return Object.values(drops).reduce((sum, count) => sum + (count > 0 ? count : 0), 0);
}

/**
 * The categories in a ledger that are GAPS, most first.
 *
 * What the run page puts in front of a person and what an agent reads to
 * answer "what did this import lose": the `expected` half is noise for that
 * question, however large it is.
 */
export function gapsIn(byReason: Readonly<Partial<Record<DropReason, number>>>): Array<{
  reason: DropReason;
  count: number;
}> {
  return Object.entries(byReason)
    .filter(([reason, count]) => (count ?? 0) > 0 && dropSeverityFor(reason as DropReason) === 'gap')
    .map(([reason, count]) => ({ reason: reason as DropReason, count: count ?? 0 }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
