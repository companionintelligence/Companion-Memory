/*
 * Canonical record → the ingest DTOs each destination actually takes.
 *
 * Ported from CI-Import-Tools' `ci-server/mapping.ts`. Upstream these built the
 * shapes for CI-Server's `/v1` HTTP contract; here they build the DTOs the
 * services take in-process, so the transport half of the port evaporates and the
 * per-kind judgement — which is all of the value — is what remains.
 *
 * The field names differ from upstream because ci-server's DTOs do: everything
 * is snake_case EXCEPT `CreateItemDto`, which is the one camelCase ingest DTO.
 * That single exception is why the provenance triple has two helpers rather than
 * one shared object spread.
 *
 * Every input carries the (source_type, source_system, source_id) triple, which
 * is what makes a re-import a no-op: each destination table has a
 * `*_source_triple_uniq` index over it.
 */
import type { CreateBrowserActivityDto } from '@ci/domains/browser-activity';
import { isUriLocation } from '@ci/domains/geocode';
import { isGloballyUniqueNamespace, type ObjectIdentifierNamespace } from '@ci/domains/graph';
import { CommunicationType, minorUnitExponent } from '@ci/domains/memory';
import type {
  CreateCommunicationDto,
  CreateContentDto,
  CreateEventDto,
  CreateItemDto,
  CreateObjectObservationDto,
  CreateProductModelDto,
  ReceiptExtraction,
  ReceiptLineItemInput,
} from '@ci/domains/memory';
import type { CreatePositionDto } from '@ci/domains/position';

import { mimeForFile } from '../datasources/timeline';

import {
  clip,
  commerceLineItems,
  discordAttachmentFilename,
  discordAttachmentUrls,
  identifiersFrom,
  isDigitalGood,
  isMediaType,
  contentFileRef,
  isAttachmentPlaceholderOnly,
  isDiscordAttachmentOnly,
  isRedditComment,
  isRedditPost,
  mintsProductModel,
  num,
  redditMediaUrl,
  str,
  type CanonicalIdentifier,
  type CanonicalRecord,
} from './canonical';
import { readCommerceField } from './commerceKeys';

/**
 * `ci.events.time_source` for a row whose source gave it NO time — the instant
 * in `start_time` was synthesized by the transform and is not evidence of
 * anything.
 *
 * Mirrors `TIME_SOURCES.INGEST` in
 * `domains/pipeline/stages/clean/TemporalRepairStage`, which is where the
 * vocabulary is defined and documented. Mirrored rather than imported because
 * the import domain has no other dependency on the pipeline domain, and pulling
 * that barrel in for one string literal would couple a hot per-row transform to
 * a Nest module full of injectable stages. `__tests__/undatedRecords.test.ts`
 * imports these two constants directly (exported for that reason alone — the
 * production coupling this docblock warns against is to the pipeline
 * module's DI graph, not to a plain string a test file reads) and asserts
 * them against the real TIME_SOURCES/TIME_PRECISIONS, so the copy cannot
 * drift without a red test — the "second reader that drifted" failure this
 * file's own header warns about.
 */
export const UNDATED_TIME_SOURCE = 'ingest';

/** `ci.events.time_precision` for the same rows — mirrors `TIME_PRECISIONS.UNKNOWN`. */
export const UNDATED_TIME_PRECISION = 'unknown';

/** The full source triple every per-destination input carries. */
/**
 * The provenance triple, snake_case — the spelling every ingest DTO uses except
 * things. It is what makes a re-import a no-op: each destination has a
 * `*_source_triple_uniq` index over it.
 */
function sourceTriple(
  rec: CanonicalRecord,
): Pick<CreateContentDto, 'source_type' | 'source_system' | 'source_id'> {
  return { source_type: rec.sourceType, source_system: rec.sourceSystem, source_id: rec.sourceId };
}

/**
 * The same triple for `CreateItemDto`, which is ci-server's one camelCase ingest
 * DTO. Kept as its own function rather than a cast so a future rename on either
 * side fails to compile instead of silently dropping the provenance.
 */
function sourceTripleCamel(
  rec: CanonicalRecord,
): Pick<CreateItemDto, 'sourceType' | 'sourceSystem' | 'sourceId'> {
  return { sourceType: rec.sourceType, sourceSystem: rec.sourceSystem, sourceId: rec.sourceId };
}

/**
 * The camelCase triple again, for the object-plane DTOs whose fields are
 * `string | null` rather than `string | undefined`.
 *
 * A third spelling of one idea is not an accident of style: the two shapes are
 * not assignable to each other, and widening either DTO to accept the other's
 * would let an absent provenance through as a legal value on a table whose
 * idempotency depends on it.
 */
function sourceTripleCamelNullable(rec: CanonicalRecord): {
  sourceType: string | null;
  sourceSystem: string | null;
  sourceId: string | null;
} {
  return { sourceType: rec.sourceType, sourceSystem: rec.sourceSystem, sourceId: rec.sourceId };
}

/**
 * An installable app package's mimetype — Amazon Appstore entitlements land
 * here as `application/vnd.android.package-archive` (see amazon.ts
 * RESOURCE_TYPE_MIME / appAsins), and an iOS equivalent would use Apple's
 * installer-manifest type. Distinct from the ebook/audio/video mimetypes the
 * same digital-purchase lane also carries — a *.apk is software, not media.
 */
const APP_PACKAGE_MIME_RE = /^application\/(vnd\.android\.package-archive|vnd\.apple\.installer\+xml)$/i;

/** The content `type` bucket for a kind (bookmark/media/purchase/note/…). */
function contentTypeFor(kind: string, mediaType: string | null): string {
  // An app package is software, not media, regardless of which kind carried it
  // here (overwhelmingly commerce.purchase — an Amazon Appstore/Play Store
  // entitlement). The mimetype is Amazon's own per-item statement of what the
  // thing IS, so it is authoritative and checked before the kind-based rules
  // below, which would otherwise fold it into 'media' alongside ebooks, songs,
  // and movies bought through the same digital-purchase lane.
  if (mediaType && APP_PACKAGE_MIME_RE.test(mediaType)) {
    return 'app';
  }

  if (kind === 'web.bookmark') {
    return 'bookmark';
  }

  // A browsing action that reached the content lane instead of
  // ci.browser_activity is an UNDATED one (destinationsFor). What survives is
  // the page itself — its URL and title — not the visit, because the visit is
  // precisely the part with no time. 'bookmark' is what that is: a URL the user
  // is on record as having had, with no moment attached. Without this branch
  // the prefix rule types it 'web', a bucket nothing renders.
  if (kind === 'web.page_view' || kind === 'web.search' || kind === 'web.download') {
    return 'bookmark';
  }

  // media.saved (a library's saved/followed track or album) is the same kind
  // of thing a play/read session's content row describes — one type family.
  if (
    kind === 'media.play' ||
    kind === 'media.watch' ||
    kind === 'media.listen' ||
    kind === 'media.read' ||
    kind === 'media.saved'
  ) {
    return 'media';
  }

  // A photo/video/audio row that reached the content lane instead of events
  // (undated — see destinationsFor) is the same kind of thing the media leg
  // creates for a dated one, so it takes the same 'media' type rather than the
  // 'capture' the generic prefix rule would give it.
  if (kind.startsWith('capture.')) {
    return 'media';
  }

  // A document, archive, or key off a drive walk / mail attachment. 'import'
  // (the prefix rule) named the pipeline that carried it, not the thing.
  if (kind === 'import.archive_item') {
    return 'file';
  }

  // A digital purchase's content row is the bought thing (an ebook, a song, a
  // movie) — the same 'media' bucket its play/read/watch rows land in, so the
  // purchase and its sessions describe one artifact, not two type families.
  // An app package purchased the same way is caught by the mimetype check
  // above and never reaches this branch.
  if (kind === 'commerce.purchase') {
    return 'media';
  }

  if (kind === 'commerce.transaction') {
    return 'transaction';
  }

  if (kind === 'reading.annotation') {
    return 'annotation';
  }

  if (kind === 'calendar.event') {
    return 'event';
  }

  if (kind === 'travel.trip') {
    return 'trip';
  }

  if (kind === 'social.post') {
    return 'post';
  }

  if (kind === 'social.comment') {
    return 'comment';
  }

  if (kind === 'social.like') {
    return 'like';
  }

  if (kind === 'social.bookmark') {
    return 'social_bookmark';
  }

  return kind.includes('.') ? kind.split('.')[0] : kind;
}

/**
 * Map a record to a CreateContentDto. Used for bookmarks, digital purchases,
 * notes/annotations, and the content side of calendar/media events. The server
 * links the row to its event via the shared source triple, so no eventId here.
 */
export function toContentInput(rec: CanonicalRecord): CreateContentDto {
  const m = rec.metadata;
  // A Reddit post/comment reaches the content lane only for its media
  // (destinationsFor routes text-only records to communications alone). The
  // media row carries the record's text with it: for a post, truncated as the
  // title and the full body as the text; a comment gets no title at all — it
  // would only repeat the text it sits next to.
  const redditMedia = redditMediaUrl(rec);
  if (redditMedia) {
    const input: CreateContentDto = {
      type: redditMedia.kind,
      url: redditMedia.url,
      source_data: m,
      ...sourceTriple(rec),
    };
    const postText = rec.description || rec.title;
    if (postText) {
      if (!isRedditComment(rec)) {
        input.title = clip(postText);
      }

      input.text = postText;
    }

    const mime = mimeForFile(new URL(redditMedia.url).pathname);
    if (mime) {
      input.mimetype = mime;
    }

    return input;
  }

  const input: CreateContentDto = {
    type: contentTypeFor(rec.kind, rec.mediaType),
    source_data: m,
    ...sourceTriple(rec),
  };
  const title = rec.title || str(m.Product) || str(m.Title);
  if (title) {
    input.title = title;
  }

  const text = rec.description || str(m.Text);
  if (text) {
    input.text = text;
  }

  // Permalink last: reddit saved posts/comments carry ONLY a permalink (no
  // URL field), and since undated ones now land content-alone, the permalink
  // is the row's single way back to the thing it describes.
  const url = str(m.URL) || str(m.Url) || str(m.url) || str(m.Permalink);
  if (url) {
    input.url = url;
  }

  // A source-native identifier (e.g. Spotify's spotify:track:<id>) doubles as
  // the row's external_id so consumers can key on it without digging into
  // source_data — and REPLACES the per-item sourceId as the content row's
  // identity. Content rows dedup server-side on the provenance triple
  // (content_source_triple_uniq); with the per-play item id in the triple,
  // every play of the same track created another copy of the same content.
  // Keying on the URI collapses them to one row per track/episode/chapter,
  // across batches and re-imports. The EVENT keeps the per-play item id, so
  // this also forfeits the server's content→event triple auto-link (a single
  // event_id could never represent N plays anyway).
  const uri = str(m.URI);
  if (uri) {
    input.external_id = uri;
    input.external_id_kind = 'external_uri';
    input.source_id = uri;
  }

  // A file-bearing record that reached content WITHOUT an events leg (an undated
  // photo, any drive-walk document) has had its bytes uploaded by
  // withContentMedia just before the send — point the row at the stored file, or
  // it would describe a document nobody can open. The file id wins over a
  // source URI: it identifies these bytes in CI-Server, which is what a consumer
  // of this row needs.
  const file = contentFileRef(rec);
  if (file.id) {
    input.external_id = file.id;
    input.external_id_kind = 'file';
  }

  if (file.url && !input.url) {
    input.url = file.url;
  }

  if (rec.mediaType) {
    input.mimetype = rec.mediaType;
  }

  return input;
}

// Object condition vocabulary -> the DTO's condition enum. Amazon records
// "New" / "Used - Like New" etc.; normalise to the closed set the column takes.
//
// Upstream returned the GraphQL enum's UPPERCASE spellings and the transport
// lowercased them on the way out (`NA` -> `n/a`). That transport is gone, so the
// conversion lives here and the function returns what the column stores.
function conditionFor(raw: string | null): CreateItemDto['condition'] | null {
  if (!raw) {
    return null;
  }

  const lc = raw.toLowerCase();
  if (lc.includes('like new') || lc.includes('like-new')) {
    return 'like_new';
  }

  if (lc.includes('refurb') || lc === 'new') {
    return 'new';
  }

  if (lc.includes('very good') || lc.includes('good')) {
    return 'good';
  }

  if (lc.includes('acceptable') || lc.includes('fair')) {
    return 'fair';
  }

  if (lc.includes('poor')) {
    return 'poor';
  }

  if (lc.includes('broken') || lc.includes('for parts')) {
    return 'broken';
  }

  // Amazon's own `Product Condition` vocabulary, which is only ever New / Used /
  // Not Available on a real Retail.OrderHistory export. A bare "Used" states no
  // grade and "Not Available" states the data is missing; CI-Server's enum has
  // no ungraded-used bucket, so both land on n/a — the honest "no grade here"
  // answer, rather than inventing GOOD. The raw string survives untouched in
  // metadata.Condition either way. Graded forms ("Used - Very Good") never
  // reach this line: they matched above.
  if (lc === 'used' || lc === 'not available' || lc === 'n/a' || lc === 'na') {
    return 'n/a';
  }

  return null;
}

// Humanise a source category token into category + optional subcategory. Amazon
// ships screaming-snake product types (ELECTRONIC_CABLE, ABIS_KITCHEN); the
// leading segment is the broad department, the remainder the subcategory. A
// plain "Electronics > Cables" hierarchy (other sources) splits on the
// separator. Returns null when there is nothing usable.
function splitCategory(raw: string): { category: string; subcategory?: string } | null {
  const cleaned = raw.trim();
  if (!cleaned) {
    return null;
  }

  // Hierarchical "A > B > C" / "A/B" → first = category, last = subcategory.
  const hier = cleaned.split(/\s*[>/]\s*/).filter(Boolean);
  if (hier.length > 1) {
    return { category: hier[0], subcategory: hier[hier.length - 1] };
  }

  // Amazon ABIS_BOOK / ELECTRONIC_CABLE style: split the snake token.
  if (/_/.test(cleaned)) {
    const parts = cleaned.split('_').filter(Boolean);
    const humanise = (s: string) =>
      s.length <= 4 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
    const category = humanise(parts[0]);
    const subcategory = parts.length > 1 ? parts.slice(1).map(humanise).join(' ') : undefined;

    return subcategory ? { category, subcategory } : { category };
  }

  return { category: cleaned };
}

/**
 * Map a `commerce.*` record to a CreateItemDto. The importer's Amazon
 * source supplies Product / Unit Price / Currency / Order ID / Quantity in
 * metadata; name falls back to the canonical title (then a placeholder, since
 * `name` is required) so a malformed row is still ingestable.
 *
 * `category`/`subcategory` are derived from a real source taxonomy (Amazon's
 * `Category` product type, or any source `Category`/`Product Category`/
 * `Product Type` field) when present, instead of collapsing every row into the
 * generic `commerce` bucket; `rec.category` (the kind prefix) is the fallback.
 * A payment processor's `Type` is deliberately NOT one of them — see the
 * CATEGORY chain in push/commerceKeys.ts.
 */
export function toThingInput(rec: CanonicalRecord): CreateItemDto {
  const m = rec.metadata;
  const orderId = str(readCommerceField(m, 'ORDER_ID'));
  const input: CreateItemDto = {
    // Precedence preserved: `Product` then the record's own title. The canonical
    // chain's extra spellings ('Item Name', 'Product Name') only fill a name
    // that would otherwise be the 'Item' placeholder.
    name: str(m.Product) || rec.title || str(readCommerceField(m, 'PRODUCT')) || 'Item',
    // Pass the full parsed metadata through — Amazon rows previously had
    // objects.metadata = '{}' because the column extractor only kept a
    // curated subset; the bag carries Source, raw Total, and any future
    // CSV fields that don't have a first-class column yet.
    metadata: m,
    ...sourceTripleCamel(rec),
  };
  if (rec.description) {
    input.description = rec.description;
  }

  // Prefer a real source taxonomy over the constant `commerce` kind-prefix.
  // The canonical CATEGORY chain IS this list, in this order — see commerceKeys.
  const rawCategory = str(readCommerceField(m, 'CATEGORY'));
  const split = rawCategory ? splitCategory(rawCategory) : null;
  if (split) {
    input.category = split.category;
    if (split.subcategory) {
      input.subcategory = split.subcategory;
    }
  } else if (rec.category) {
    input.category = rec.category;
  }

  // Brand keeps its OWN precedence, which is NOT the merchant chain's.
  //
  // A canonical chain FILLS a field that resolved to nothing; it must never
  // re-rank one that already resolved. `Brand → Manufacturer → Seller` is what
  // this field has always meant (an explicit brand outranks the shop, and the
  // shop that actually sold it outranks the marketplace it was listed on), so
  // those three come first, verbatim. The merchant chain then fills the gap —
  // which is how a Google purchase finally gets a brand at all: it writes
  // `Merchant`, and the old chain never read that key.
  //
  // `Processor` is deliberately absent from the MERCHANT chain: it is the
  // PAYMENT processor (reddit.ts writes Stripe/PayPal), and a payment processor
  // is not the brand of the thing bought.
  const brand = str(m.Brand) || str(m.Manufacturer) || str(m.Seller) || str(readCommerceField(m, 'MERCHANT'));
  if (brand) {
    input.brand = brand;
  }

  // `ci.objects.model` — the manufacturer designation ("MX Master 3S",
  // "A2338"), the one string that tells two otherwise identical rows apart. The
  // column, the DTO field and the search tsvector have all existed since the
  // object-identity migration; nothing was ever writing it from an import.
  const model = str(m.Model) || str(m['Model Number']) || str(m.ModelNumber);
  if (model) {
    input.model = model;
  }

  const condition = conditionFor(str(readCommerceField(m, 'CONDITION')));
  if (condition) {
    input.condition = condition;
  }

  // Same rule as brand: the field's own precedence FIRST ('Unit Price' then
  // 'Total' — what this field has always meant), the canonical chains only to
  // fill a price that resolved to nothing (reddit's `Cost`, PayPal's `Net`).
  // Without the split, `Price` — a UNIT_PRICE alias — jumps ahead of a stated
  // `Total` and halves the recorded spend on every row carrying both.
  //
  // A NEGATIVE price is refused outright. The TOTAL chain reaches PayPal/Venmo
  // ledger columns (`Amount`, `Net`, `Gross`) which are SIGNED: a refund or an
  // outgoing payment is negative there, and "this item cost -42.50" is not a
  // fact about a purchase.
  const price =
    num(m['Unit Price']) ??
    num(m.Total) ??
    num(readCommerceField(m, 'UNIT_PRICE')) ??
    num(readCommerceField(m, 'TOTAL'));
  if (price != null && price >= 0) {
    input.purchasePrice = price;
  }

  const currency = str(readCommerceField(m, 'CURRENCY'));
  if (currency) {
    input.currency = currency;
  }

  if (rec.startTime) {
    input.acquiredAt = new Date(rec.startTime);
  }

  const qty = num(readCommerceField(m, 'QUANTITY'));

  // Whole and positive, per the column's contract. A fractional "quantity" is a
  // weight ("0.75 kg of apples"), which this column cannot express — better no
  // claim than a rounded one.
  if (qty != null && Number.isInteger(qty) && qty > 0) {
    input.quantity = qty;
  }

  // Identifier codes: keep the order id (and quantity, when present) as a small
  // structured bag. sourceId already carries the order id for dedup; this is the
  // human-facing copy on the item.
  const identifierCodes: Record<string, unknown> = {};
  if (orderId) {
    identifierCodes.order_id = orderId;
  }

  if (qty != null) {
    identifierCodes.quantity = qty;
  }

  const asin = str(m.ASIN) || str(m['ASIN/ISBN']) || str(m.ISBN);
  if (asin) {
    identifierCodes.asin = asin;
  }

  // The normalized identifiers the record states, under the namespace keys
  // `ObjectIdentifierService` reads (see ReceiptService.CODE_KEY_NAMESPACES).
  // Written ALONGSIDE the raw `asin` above rather than instead of it: the flat
  // key is what existing readers of the bag look at, and an ISBN-10 filed as an
  // ASIN normalizes to `isbn` here, so the two are not the same string.
  Object.assign(identifierCodes, identifierCodesFor(rec.identifiers));

  if (Object.keys(identifierCodes).length) {
    input.identifierCodes = identifierCodes;
  }

  return input;
}

/* -------------------------------------------------------------------------- *
 * Commerce plane: receipts, product models, observations.
 *
 * A purchase is three different facts, and CI-Server keeps them in three tables
 * because they answer three different questions:
 *
 *   receipt        WHEN and WHERE money changed hands, and for WHAT — the
 *                  merchant, the total, and the itemisation. This is the row
 *                  that gives a purchase a place on the timeline and a map.
 *   product model  WHAT the thing IS, independent of this purchase — the
 *                  catalogue entry an ISBN/ASIN/GTIN identifies, shared by
 *                  everyone who ever buys it.
 *   observation    THAT an identified object was somewhere at some moment. A
 *                  receipt is the most reliable producer of these: it is dated,
 *                  placed, and identifier-bearing.
 *
 * ── Money is MINOR UNITS here ──────────────────────────────────────────────
 *
 * `ci.receipts` and `ci.receipt_line_items` are integer minor units end to end
 * (see memory/entities/minorUnits). The parsers speak major units, so every
 * amount crosses through {@link toMinorUnits}, which uses the currency's own
 * exponent — dividing yen by 100 turns ¥1,200 into ¥12.
 * -------------------------------------------------------------------------- */

/**
 * A major-unit amount as integer minor units of `currency`, or undefined.
 *
 * `Math.round` and not truncation: 19.99 in float is 19.989999999999998, and
 * truncating it books the purchase a cent light.
 */
function toMinorUnits(
  amount: number | null | undefined,
  currency: string | null | undefined,
): number | undefined {
  if (amount == null || !Number.isFinite(amount)) {
    return undefined;
  }

  return Math.round(amount * 10 ** minorUnitExponent(currency));
}

/**
 * The same, for a column that means WHAT THIS PURCHASE COST — refusing a
 * negative amount rather than writing one.
 *
 * The TOTAL chain (push/commerceKeys.ts) reaches `Amount` / `Net` / `Gross` /
 * `Total Owed`, which are SIGNED ledger columns: PayPal books a refund as a
 * negative `Amount`, Amazon writes `Total` verbatim from a CSV that does the
 * same, and neither parser clamps. Left alone, `-19.99` reached
 * `ci.receipts.total_minor` and `ci.receipt_line_items.total_price_minor` as
 * `-1999`. Neither column has a CHECK, so it landed silently and every "what
 * did I spend" read summed a credit as a cost.
 *
 * REFUSED, NOT MODELLED, and the choice is forced rather than preferred: a
 * refund is a real receipt shape, but `ci.receipts` has no status column to
 * say so (see migration 20260803223019 — the lifecycle it carries is
 * `extraction_state`, about the READ of the document, not about the purchase).
 * Modelling credits honestly needs that column, and inventing the meaning by
 * leaving a negative in a cost column is not a substitute. The refused amount
 * is not lost: it stays in `ci.receipts.metadata`, under the key the parser
 * wrote it as, and {@link toReceiptInput} names it explicitly.
 *
 * The things lane already refused negatives for exactly this reason; this is
 * that rule reaching the lane that was added next to it.
 */
function toCostMinorUnits(
  amount: number | null | undefined,
  currency: string | null | undefined,
): number | undefined {
  if (amount == null || !Number.isFinite(amount) || amount < 0) {
    return undefined;
  }

  return toMinorUnits(amount, currency);
}

/**
 * Which `identifierCodes` key each namespace is written under.
 *
 * The keys are `ReceiptService.CODE_KEY_NAMESPACES`' own, so a code written
 * here is one that service will read back. `order_id` is deliberately ABSENT
 * for the reason that map gives: the claim index is first-writer-wins on
 * `(owner, namespace, value, qualifier)`, and an order id belongs to the ORDER,
 * not to any one thing in it — claiming it for a single line would silently
 * swallow every other line on the same order.
 */
const IDENTIFIER_CODE_KEYS: Partial<Record<ObjectIdentifierNamespace, string>> = {
  gtin: 'gtin',
  isbn: 'isbn',
  asin: 'asin',
  mpn: 'mpn',
  sku: 'sku',
  serial: 'serial',
  imei: 'imei',
  vin: 'vin',
};

/**
 * Canonical identifiers as the flat `identifierCodes` bag the services read.
 *
 * The bag holds ONE value per namespace, so a record stating two ASINs keeps
 * the first — deterministic, because `identifiersFrom` preserves the source's
 * own order.
 */
function identifierCodesFor(
  identifiers: CanonicalIdentifier[] | undefined,
): Record<string, string> | undefined {
  if (!identifiers?.length) {
    return undefined;
  }

  const codes: Record<string, string> = {};

  for (const identifier of identifiers) {
    const key = IDENTIFIER_CODE_KEYS[identifier.namespace];

    if (key && codes[key] == null) {
      codes[key] = identifier.value;
    }
  }

  return Object.keys(codes).length ? codes : undefined;
}

/** Sum of a line-item field across the lines, or undefined when none had it. */
function sumLines(
  lines: ReceiptLineItemInput[],
  pick: (l: ReceiptLineItemInput) => number | null | undefined,
): number | undefined {
  let total: number | undefined;

  for (const line of lines) {
    const v = pick(line);

    if (v == null) {
      continue;
    }

    total = (total ?? 0) + v;
  }

  return total;
}

/**
 * A collision-free line number per entry, in emit order.
 *
 * Stated numbers are claimed FIRST (a parser that states one always keeps it,
 * wherever it sits in the array), then every remaining line takes its position
 * `i + 1` — the obvious behaviour — falling back to the lowest unclaimed
 * positive integer when that position is already spoken for. So
 * `[{LineNumber: 7}, {}]` is `[7, 2]`, while `[{LineNumber: 2}, {}]` is
 * `[2, 1]` instead of `[2, 2]`: two lines of one receipt can never share a
 * number, which matters because `(receipt_id, line_number)` is the natural key
 * `ReceiptService.replaceLineItems` upserts on — and that method folds
 * within-batch repeats last-write-wins, so a collision would silently DELETE a
 * line rather than fail.
 */
function assignLineNumbers(entries: Array<Record<string, unknown>>): number[] {
  const stated = entries.map((e) => {
    const n = num(e.LineNumber) ?? num(e.line_number);

    return n != null && n > 0 ? Math.trunc(n) : null;
  });
  const out = Array.from<number | undefined>({ length: entries.length });
  const claimed = new Set<number>();

  // Pass 1: every stated number that nothing else claimed already.
  stated.forEach((n, i) => {
    if (n == null || claimed.has(n)) {
      return;
    }

    claimed.add(n);
    out[i] = n;
  });

  // Pass 2: positional, then the lowest free number for the leftovers
  // (unstated lines, and duplicate statements after the first).
  let next = 1;

  for (let i = 0; i < entries.length; i++) {
    if (out[i] != null) {
      continue;
    }

    let n = i + 1;

    if (claimed.has(n)) {
      while (claimed.has(next)) {
        next += 1;
      }

      n = next;
    }

    claimed.add(n);
    out[i] = n;
  }

  return out as number[];
}

/**
 * A synthetic CanonicalRecord for one line entry, so {@link isDigitalGood} sees
 * the LINE's fields first and the parent's only as a fallback. Nothing else
 * consumes it — it exists purely so the digital/physical rule has one
 * implementation rather than two.
 */
function lineAsRecord(
  rec: CanonicalRecord,
  entry: Record<string, unknown>,
  description: string,
): CanonicalRecord {
  return { ...rec, title: description, metadata: { ...rec.metadata, ...entry } };
}

/** One receipt line, from a metadata bag that describes exactly one thing. */
function lineFrom(
  rec: CanonicalRecord,
  source: Record<string, unknown>,
  lineNumber: number,
  identifiers: CanonicalIdentifier[],
  description: string,
): ReceiptLineItemInput {
  const quantity = num(readCommerceField(source, 'QUANTITY'));
  const currency =
    str(readCommerceField(source, 'CURRENCY')) ?? str(readCommerceField(rec.metadata, 'CURRENCY'));
  const unitPrice = num(readCommerceField(source, 'UNIT_PRICE'));
  // `total_price_minor` is the LINE's own total, and that is a PRE-TAX number:
  // the header carries tax, shipping and discount in their own columns, and
  // `subtotal + tax + shipping − discount = total` only closes if the lines
  // sum to the subtotal. So a stated `Subtotal` — the line's extended price —
  // wins over a stated `Total`, which on a per-line export is what that line
  // was CHARGED with its share of tax already in it.
  //
  // Amazon is where this bit: every one of its lines stated `Total` = the row's
  // `Total Amount`, so a 71.85 item with 5.57 of tax was stored as a line total
  // of 77.42, and single-line orders "reconciled" 630/630 purely because the
  // line had been handed the order's own total. The fallback to `Total`
  // survives for the sources that state only that (Uber Eats, a receipt email),
  // and unit × quantity for the ones that state neither.
  const total =
    num(readCommerceField(source, 'SUBTOTAL')) ??
    num(readCommerceField(source, 'TOTAL')) ??
    (unitPrice != null ? unitPrice * (quantity ?? 1) : undefined);

  const line: ReceiptLineItemInput = {
    lineNumber,
    description,
    // Physical object vs digital good, DECIDED HERE and recorded on the row,
    // rather than re-derived from the product name on every push. See
    // isDigitalGood for the evidence order; writing it down is what makes the
    // decision auditable (and correctable) instead of a heuristic that silently
    // changes meaning when the regex changes.
    isPhysical: !isDigitalGood(lineAsRecord(rec, source, description)),
  };

  if (quantity != null && quantity > 0) {
    line.quantity = quantity;
  }

  if (currency) {
    line.currency = currency;
  }

  // Cost columns, so a negative is refused rather than written — see
  // toCostMinorUnits. A PayPal refund line reached here as `unitPriceMinor:
  // -4250, totalPriceMinor: -4250`.
  const unitMinor = toCostMinorUnits(unitPrice, currency);
  if (unitMinor != null) {
    line.unitPriceMinor = unitMinor;
  }

  const totalMinor = toCostMinorUnits(total, currency);
  if (totalMinor != null) {
    line.totalPriceMinor = totalMinor;
  }

  const category = str(readCommerceField(source, 'CATEGORY'));
  if (category) {
    line.category = category;
  }

  const brand = str(source.Brand) ?? str(source.Manufacturer);
  if (brand) {
    line.brand = brand;
  }

  const modelNumber = str(source.Model) ?? str(source['Model Number']) ?? str(source.ModelNumber);
  if (modelNumber) {
    line.modelNumber = modelNumber;
  }

  // `identifierCodes` is what `ReceiptService.upsertFromExtraction` resolves the
  // line's product from and promotes into `ci.object_identifiers` — the reason
  // a book bought on Amazon and the same book scanned off its barcode land on
  // one catalogue row.
  const codes = identifierCodesFor(identifiers);
  if (codes) {
    line.identifierCodes = codes;
  }

  return line;
}

/**
 * Map a record to its receipt lines.
 *
 * Two shapes reach here:
 *   - a record with `metadata.LineItems` (an Amazon order aggregate, an Uber
 *     Eats order, a detected receipt email): one line per entry, IN THE ORDER
 *     THE PARSER EMITTED THEM.
 *   - a bare purchase line (one Amazon order line, one Google purchase, one
 *     Reddit coin bundle): the record IS the single line.
 *
 * LINE NUMBER STABILITY. `(receipt_id, line_number)` is the natural key, so a
 * re-import that renumbers is a re-import that forks its lines. A parser may
 * state the number (`LineNumber` on the entry) and that wins; an unstated one
 * takes the array index, which is stable because every emitter builds the array
 * in a deterministic pass over its export. See {@link assignLineNumbers} for
 * the mixed case.
 */
export function toReceiptLineItemInputs(rec: CanonicalRecord): ReceiptLineItemInput[] {
  const raw = commerceLineItems(rec);

  if (raw.length === 0) {
    const description = str(readCommerceField(rec.metadata, 'PRODUCT')) ?? rec.title;

    // A record that names nothing has no line worth writing. The receipt header
    // still stands — merchant, money and moment are the point of it.
    return description ? [lineFrom(rec, rec.metadata, 1, rec.identifiers ?? [], description)] : [];
  }

  const numbers = assignLineNumbers(raw);

  return raw.map((entry, i) => {
    const description = str(readCommerceField(entry, 'PRODUCT')) ?? str(entry.Description) ?? 'Item';

    // A line is judged on its OWN fields, falling back to the parent record's —
    // a digital item inside an otherwise physical order is a real case (a gift
    // card on a grocery run).
    return lineFrom(rec, entry, numbers[i], identifiersFrom(entry), description);
  });
}

/** A receipt's money breakdown disagreeing with its total, or null when it adds up. */
export interface ReceiptTotalsMismatch {
  /** subtotal + tax + shipping − discount, in minor units. */
  expectedMinor: number;
  /** What the receipt says it came to, in minor units. */
  statedMinor: number;
  /** expected − stated. Positive: the parts overshoot what was charged. */
  deltaMinor: number;
}

/**
 * Does this breakdown add up to this total?
 *
 * Returns the disagreement, or null when it reconciles OR when there is not
 * enough to check — a receipt that states no subtotal, or no total, is silent
 * rather than wrong, and a silence must not be reported as a violation.
 *
 * A missing tax/shipping/discount counts as ZERO here, deliberately: a source
 * that states a subtotal and a total but no tax is claiming there was none, and
 * that claim is exactly what this invariant is for.
 *
 * TOLERANCE is one minor unit. The components are rounded into minor units
 * independently (a per-unit tax times a quantity of three rounds where the
 * source's own per-line figure did not), and a cent of rounding is not a
 * disagreement about what was charged.
 */
function reconciliationMismatch(
  subtotal: number | undefined,
  tax: number | undefined,
  shipping: number | undefined,
  discount: number | undefined,
  total: number | null | undefined,
): ReceiptTotalsMismatch | null {
  if (subtotal == null || total == null) {
    return null;
  }

  const expectedMinor = subtotal + (tax ?? 0) + (shipping ?? 0) - (discount ?? 0);
  const deltaMinor = expectedMinor - total;

  return Math.abs(deltaMinor) <= 1 ? null : { expectedMinor, statedMinor: total, deltaMinor };
}

/**
 * Graph nodes the PUSH resolved for a receipt, because this mapper cannot: they
 * are `ci.entities` ids, and only the stage has the entity mappings and the
 * graph service. See `PushStage.receiptPlacesFor`.
 */
export interface ReceiptEntityLinks {
  /** `ci.receipts.place_entity_id` — the graph Location the purchase happened at. */
  placeEntityId?: string;
}

/**
 * Map a `commerce.*` record to its receipt header.
 *
 * `total` prefers what the source SAID the receipt came to, and only falls back
 * to the sum of the lines — a stated total includes tax and shipping, which the
 * lines do not, so summing first would quietly understate every order.
 */
export function toReceiptInput(
  rec: CanonicalRecord,
  lines: ReceiptLineItemInput[],
  links: ReceiptEntityLinks = {},
): ReceiptExtraction {
  const m = rec.metadata;
  const currency = str(readCommerceField(m, 'CURRENCY'));
  const extraction: ReceiptExtraction = {
    purchasedAt: new Date(rec.startTime),
    metadata: m,
    lines,
    // The source's own structured export, not an OCR read of a crumpled
    // thermal receipt: that distinction is what `ReceiptService` writes onto
    // every identifier claim it promotes as `identity_confidence`.
    extractionSource: 'structured',
    // The importer OWNS the `ci.objects` row for a purchase — it has the full
    // metadata bag and the provenance triple, and `toThingInput` already
    // wrote it. Letting the mint create a second unit from the same line is a
    // duplicate possession with no way to tell which is real. `skipMint` exists
    // for exactly this ("import backfills that only want the evidence").
    skipMint: true,
    // An itemised source has said everything it is going to say; a bare receipt
    // email has a body a real extraction could still do better with, so it stays
    // `pending` rather than claiming a finished read.
    extractionState: lines.length > 0 && commerceLineItems(rec).length > 0 ? 'extracted' : 'pending',
    ...sourceTripleCamelNullable(rec),
  };

  const merchant = str(readCommerceField(m, 'MERCHANT'));
  if (merchant) {
    extraction.merchantName = merchant;
  }

  // WHERE the purchase happened. This is the difference between a receipt and
  // a bare object row: `ci.receipts.place_entity_id` is the "known place"
  // rung of `ObjectResolutionService` (`place_prior`), and it is what puts an
  // imported purchase on the map at all — no import path populated it before.
  //
  // `merchant_entity_id` is deliberately still null. Resolving the merchant
  // STRING into a graph Organization would mint one node per distinct merchant
  // in a mailbox, which is a graph-volume decision that belongs with the
  // merchant-resolution work rather than being smuggled in here;
  // `merchant_name` above already carries the name as printed.
  if (links.placeEntityId) {
    extraction.placeEntityId = links.placeEntityId;
  }

  if (currency) {
    extraction.currency = currency;
  }

  // A NEGATIVE stated total is a refund or a credit, not a cost, and it is
  // refused outright — including the line-sum fallback below, which would
  // otherwise answer with whatever positive lines survived the same guard and
  // report a credit as a purchase. See toCostMinorUnits for why this lane
  // refuses rather than models.
  const stated = num(readCommerceField(m, 'TOTAL'));
  const refusedTotal = stated != null && Number.isFinite(stated) && stated < 0;
  const total = refusedTotal
    ? undefined
    : (toCostMinorUnits(stated, currency) ?? sumLines(lines, (l) => l.totalPriceMinor));
  if (total != null) {
    extraction.totalMinor = total;
  }

  if (refusedTotal) {
    // Refused, not lost. The amount stays legible on the receipt — a later
    // pass that grows a real credit/refund model has the number it needs, and
    // nobody reading the row has to guess why the total is empty.
    extraction.metadata = { ...m, NegativeTotalRefused: stated };
  }

  // The money BREAKDOWN. All four are COST columns, so a negative is refused
  // rather than written (see toCostMinorUnits) — including `Discount`, which is
  // the positive MAGNITUDE taken off the order, not a signed adjustment. A
  // source whose export states discounts negatively normalises the sign in its
  // own parser, where that convention is a verified fact about the export.
  const subtotal = toCostMinorUnits(num(readCommerceField(m, 'SUBTOTAL')), currency);
  if (subtotal != null) {
    extraction.subtotalMinor = subtotal;
  }

  const tax = toCostMinorUnits(num(readCommerceField(m, 'TAX')), currency);
  if (tax != null) {
    extraction.taxMinor = tax;
  }

  const shipping = toCostMinorUnits(num(readCommerceField(m, 'SHIPPING')), currency);
  if (shipping != null) {
    extraction.shippingMinor = shipping;
  }

  const discount = toCostMinorUnits(num(readCommerceField(m, 'DISCOUNT')), currency);
  if (discount != null) {
    extraction.discountMinor = discount;
  }

  // THE RECONCILIATION INVARIANT: subtotal + tax + shipping − discount = total.
  //
  // A breakdown is four numbers that only mean anything together, and a wrong
  // one is invisible on its own — the row still shows four plausible amounts
  // and a total. This identity is the only thing that can catch it, so it runs
  // on every receipt that states enough to be checked, whatever wrote it.
  //
  // The components are still WRITTEN when they disagree: they are the source's
  // own numbers and dropping them loses more than it protects. What is not
  // allowed is storing a wrong breakdown SILENTLY, so the disagreement is
  // stamped on the receipt where a reader of the row will find it.
  const mismatch = reconciliationMismatch(subtotal, tax, shipping, discount, extraction.totalMinor);
  if (mismatch) {
    extraction.metadata = { ...extraction.metadata, TotalsMismatch: mismatch };
  }

  const orderId = str(readCommerceField(m, 'ORDER_ID'));
  if (orderId) {
    extraction.orderNumber = orderId;
  }

  // The receipt body / order note. `rawText` is the column a later, better
  // extraction re-reads, which is the whole reason a receipt email raises its
  // body cap to 32k (see gmail.ts).
  const notes = rec.description ?? str(m.Text) ?? str(m.Notes) ?? str(m.Note);
  if (notes) {
    extraction.rawText = notes;
  }

  return extraction;
}

/**
 * The identity a catalogue row is keyed on: the first globally-unique
 * identifier the record states, in the source's own order.
 *
 * `ci.product_models` is a CATALOGUE — the same ISBN bought on Amazon, shelved
 * on Goodreads and scanned off a barcode is ONE product — so the provenance
 * triple that makes the write idempotent is keyed on the IDENTITY rather than
 * on the record that happened to mention it. Keying it on the record's own
 * `sourceId` instead would mint a second catalogue row per source, and the
 * first-writer-wins claim index would leave the later ones permanently
 * unreachable by barcode.
 */
function productIdentity(rec: CanonicalRecord): CanonicalIdentifier | null {
  return (rec.identifiers ?? []).find((i) => isGloballyUniqueNamespace(i.namespace)) ?? null;
}

/**
 * The `source_system` every importer-minted catalogue row carries.
 *
 * A constant, not the parser's name, because the row is keyed on the PRODUCT's
 * identity and not on who mentioned it — see {@link productIdentity}. The
 * parser that minted it is recorded in `metadata.mintedFrom`.
 */
export const PRODUCT_MODEL_SOURCE_SYSTEM = 'object_identity';

/** Product attributes worth carrying into the catalogue entry, when stated. */
const PRODUCT_SPEC_KEYS = [
  'Publisher',
  'Binding',
  'NumberOfPages',
  'Number of Pages',
  'YearPublished',
  'Year Published',
  'Author',
  'Edition',
  'Format',
  'Color',
  'Size',
] as const;

/**
 * Map a record to the catalogue entry its identifiers mint, or null when it
 * mints none (no globally-unique identifier, or nothing to name it).
 *
 * Only globally-unique identifiers qualify: a SKU is unique inside one
 * retailer, and a catalogue keyed on one would collide across shops.
 *
 * `identityConfidence` is left at the column default (1.0). An
 * identifier-keyed catalogue row is not a guess — the ISBN IS the product —
 * which is precisely the distinction `ProductModelService.findOrCreateByBrandModel`
 * lowers its own confidence to make.
 */
export function toProductModelInput(rec: CanonicalRecord): CreateProductModelDto | null {
  const identity = productIdentity(rec);

  if (identity == null) {
    return null;
  }

  const m = rec.metadata;
  const title = str(readCommerceField(m, 'PRODUCT')) ?? rec.title;

  if (!title) {
    return null;
  }

  const input: CreateProductModelDto = {
    title,
    isDigital: isDigitalGood(rec),
    metadata: {
      // Which record minted the row, since the triple below no longer says.
      mintedFrom: { sourceSystem: rec.sourceSystem, sourceId: rec.sourceId },
      identifiers: rec.identifiers ?? [],
    },
    sourceType: rec.sourceType,
    sourceSystem: PRODUCT_MODEL_SOURCE_SYSTEM,
    sourceId: `${identity.namespace}:${identity.value}`,
  };

  const brand = str(m.Brand) ?? str(readCommerceField(m, 'MERCHANT'));
  if (brand) {
    input.brand = brand;
  }

  const manufacturer = str(m.Manufacturer) ?? str(m.Publisher);
  if (manufacturer) {
    input.manufacturer = manufacturer;
  }

  const modelNumber = str(m.Model) ?? str(m['Model Number']) ?? str(m.ModelNumber);
  if (modelNumber) {
    input.modelNumber = modelNumber;
  }

  const rawCategory = str(readCommerceField(m, 'CATEGORY'));
  const split = rawCategory ? splitCategory(rawCategory) : null;
  if (split) {
    input.category = split.category;
    if (split.subcategory) {
      input.subcategory = split.subcategory;
    }
  }

  if (rec.description) {
    input.description = rec.description;
  }

  const spec: Record<string, unknown> = {};
  for (const key of PRODUCT_SPEC_KEYS) {
    const v = m[key];

    if (v !== undefined && v !== null && v !== '') {
      spec[key] = v;
    }
  }

  if (Object.keys(spec).length) {
    input.spec = spec;
  }

  return input;
}

/**
 * The identifier claims a catalogue row asserts, for
 * `ObjectIdentifierService.upsertForSubjects`.
 *
 * Only the globally-unique ones: a SKU claimed at product level would be a
 * barcode nobody else can match, and the claim index is first-writer-wins, so a
 * wrong claim is permanent.
 */
export function productModelIdentifiers(rec: CanonicalRecord): CanonicalIdentifier[] {
  return (rec.identifiers ?? []).filter((i) => isGloballyUniqueNamespace(i.namespace));
}

/**
 * Map a record to the observation its purchase constitutes, or null when the
 * record identifies no object.
 *
 * A dated receipt for an identified physical object is evidence the object was
 * with the user at that moment — the (object, time, place) triple
 * `ci.object_observations` exists to hold. Undated records produce nothing: an
 * observation with no time is not an observation.
 *
 * `sourceKind: 'manual'` is a compromise the schema forces. The column's CHECK
 * constraint allows only photo/video_frame/live_camera/screenshot/manual, all
 * of which describe PIXELS — there is no 'receipt' kind, and adding one is a
 * migration. `manual` is the closest honest reading ("asserted by a record, not
 * seen by a detector"); `detector` says what really produced it.
 */
export function toObservationInput(rec: CanonicalRecord): CreateObjectObservationDto | null {
  if (!rec.dated || !mintsProductModel(rec)) {
    return null;
  }

  const m = rec.metadata;
  // Required: a label-less sighting is refused by the service, and the product
  // name is the only label a receipt has.
  const label = str(readCommerceField(m, 'PRODUCT')) ?? rec.title;

  if (!label) {
    return null;
  }

  const input: CreateObjectObservationDto = {
    observedAt: new Date(rec.startTime),
    sourceKind: 'manual',
    label,
    labelSource: 'import',
    detector: 'import:receipt',
    attributes: {
      identifiers: productModelIdentifiers(rec),
      ...(str(readCommerceField(m, 'MERCHANT')) ? { merchant: str(readCommerceField(m, 'MERCHANT')) } : {}),
      ...(rec.locationName ? { locationName: rec.locationName } : {}),
    },
    sourceType: rec.sourceType,
    sourceSystem: rec.sourceSystem,
    sourceId: rec.sourceId,
  };

  const quantity = num(readCommerceField(m, 'QUANTITY'));
  if (quantity != null && Number.isInteger(quantity) && quantity > 0) {
    input.attributes = { ...input.attributes, quantity };
  }

  if (rec.coordinates) {
    input.coordinates = { lat: rec.coordinates.lat, lon: rec.coordinates.lon };
  }

  return input;
}

const COMMUNICATION_TYPE_BY_KIND: Record<string, CommunicationType> = {
  'communication.email': CommunicationType.EMAIL,
  'communication.call': CommunicationType.CALL,
  'communication.message': CommunicationType.CHAT,
};

/**
 * The types a source is allowed to declare for itself.
 *
 * Deliberately a subset of the `CommunicationType` enum: these are the values
 * upstream's sources actually emit, and widening it to the whole enum would let
 * a typo in one export's metadata pick `video_call` for every message in it.
 */
const DECLARABLE_TYPES = new Map<string, CommunicationType>([
  ['email', CommunicationType.EMAIL],
  ['sms', CommunicationType.SMS],
  ['call', CommunicationType.CALL],
  ['chat', CommunicationType.CHAT],
  ['post', CommunicationType.POST],
]);

/**
 * communicationType for a record: the importer's explicit
 * `metadata.CommunicationType` when it names one of CI-Server's types,
 * otherwise the `communication.*` kind suffix.
 *
 * The override exists because one source can carry several types under a single
 * kind — a Twitter/X archive holds public POSTS (tweets, likes) alongside
 * one-to-one CHAT (DMs), and every one of them is classified 'message'.
 */
export function communicationTypeFor(kind: string, metadata?: Record<string, unknown>): CommunicationType {
  const declared = str(metadata?.CommunicationType)?.toLowerCase();
  const mapped = declared ? DECLARABLE_TYPES.get(declared) : undefined;

  if (mapped) {
    return mapped;
  }

  return COMMUNICATION_TYPE_BY_KIND[kind] ?? CommunicationType.CHAT;
}

/**
 * Map a `communication.*` record to a CreateCommunicationDto. Body text comes
 * from the canonical description (metadata Text/Body/Message); `direction`
 * normalises the importer's outgoing/incoming/sent/received vocabulary to
 * CI-Server's inbound/outbound (default inbound).
 */
export function toCommunicationInput(rec: CanonicalRecord): CreateCommunicationDto {
  const m = rec.metadata;
  // A message whose only payload is its attachments has no text of its own —
  // see isDiscordAttachmentOnly / isAttachmentPlaceholderOnly for why the title
  // fallbacks must not fill it in with a synthesized "Message — <sender>".
  const content =
    isDiscordAttachmentOnly(rec) || isAttachmentPlaceholderOnly(rec)
      ? ''
      : (rec.description ?? rec.title ?? '');
  const input: CreateCommunicationDto = {
    communication_type: communicationTypeFor(rec.kind, m),
    time: new Date(rec.startTime),
    content,
    // `direction` is REQUIRED here where upstream left it optional, so a record
    // whose source states no direction still needs one. `inbound` is the
    // conservative default: an archived message that never says the user sent it
    // is far more often one they received, and mislabelling a received message
    // as sent would misattribute authorship. The branches below overwrite this
    // wherever the source actually says.
    direction: 'inbound',
    // The full metadata bag, same as toEventInput: fields with no dedicated
    // column (a tweet's URL/Retweets/Likes/Lang/ReplyTo, for example) have
    // nowhere else to land and were silently dropped without this. Fields
    // ALSO promoted to a dedicated column below (Duration, Subject, ...)
    // stay here too, for the same round-trip-completeness reason
    // toEventInput keeps them.
    metadata: { ...m },
    ...sourceTriple(rec),
  };
  // Pass call duration through so the server stores it on the Communication entity.
  if (m.Duration != null) {
    input.duration_seconds = Number(m.Duration);
  }

  const preview = content ? clip(content, 140) : null;
  if (preview && preview !== content) {
    input.preview = preview;
  }

  // Reddit posts and comments: the post title is the subject (comments have
  // none), the subreddit is the thread, and direction reads as authored
  // (outbound) vs saved-from-someone (inbound). The messaging-specific
  // participant/direction derivation below doesn't apply.
  if (isRedditPost(rec) || isRedditComment(rec)) {
    input.communication_type = CommunicationType.POST;
    input.direction = typeof m.Kind === 'string' && m.Kind.startsWith('saved_') ? 'inbound' : 'outbound';
    // A post has a real authored title, so it becomes the subject. A comment
    // has none — the only subject we could derive is a snippet of its own body,
    // which `content` already carries in full, so it stays blank.
    if (rec.title && !isRedditComment(rec)) {
      input.subject = rec.title;
    }

    const subreddit = str(m.Subreddit);
    if (subreddit) {
      input.thread_id = `r/${subreddit}`;
    }

    return input;
  }

  const subject = str(m.Subject);
  if (subject) {
    input.subject = subject;
  }

  const direction = directionFor(m);
  if (direction) {
    input.direction = direction;
  }

  // `Conversation` is the key eleven datasources already stamp the per-chat
  // identity onto (claude, chatgpt, discord, facebook, googlevoice, grok,
  // instagram, linkedin, telegram, tiktok, whatsapp) — it is this codebase's
  // most common spelling of "which conversation is this", not a display-only
  // label. It was missing from this chain, so every source that did not ALSO
  // stamp ThreadId lost its grouping here and landed with
  // ci.communications.thread_id NULL: 4,840 LinkedIn rows, 228 Instagram and 4
  // Claude, measured on the live database. Both special-case mappers below
  // (Messenger, WhatsApp) had to read it themselves precisely because this
  // chain did not.
  //
  // It sits AFTER Thread (a source that stamps both means the explicit one) and
  // BEFORE MessageID, which is a per-MESSAGE id — a last-resort key that makes
  // every message its own thread, so a real conversation key must beat it.
  const thread = str(m.ThreadId) || str(m.Thread) || str(m.Conversation) || str(m.MessageID);
  if (thread) {
    input.thread_id = thread;
  }

  // fromEntityId / toEntityIds expect UUIDs — we don't have entity resolution at
  // import time, so the raw sender + recipients ride in participantsMetadata for
  // the server to resolve. `from` is a raw string; `to` is an array of raw
  // strings (the SHARED CONTRACT shape).
  const from = str(m.Contact) || str(m.Sender) || str(m.From);
  const to = recipientsFrom(m);
  if (from || to.length) {
    input.participants_metadata = {
      ...(input.participants_metadata ?? {}),
      ...(from ? { from } : {}),
      ...(to.length ? { to } : {}),
    };
  }

  // Attachments: CI-Server ids stamped by the push's media leg (graphql.ts
  // withCommunicationMedia) just before the send. AttachmentFileIds are the
  // stored files — always present when the record had attachments that landed.
  // AttachmentContentIds are the ci.content rows over them, present only for
  // sources that describe their media well enough to catalogue it: a twitter
  // photo knows its type and its URL on X, and Messenger opts in; an MMS part
  // is bare bytes, so it lands as a file alone. The two arrays are
  // index-aligned, so attachment i is { file: fileIds[i], content:
  // contentIds[i] } — the pairing is preserved in metadata, while the column
  // gets a flat list in the `{ type, id }` vocabulary CI-Server expects.
  const attachments = attachmentsFor(m);
  if (attachments) {
    input.attachments = attachments;
  }

  return input;
}

/** The non-empty strings in a metadata value that should hold an id array. */
function strIds(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((id): id is string => typeof id === 'string' && id.length > 0) : [];
}

/** The `attachments` column value for a communication, or undefined if it has none. */
function attachmentsFor(m: Record<string, unknown>): Array<Record<string, unknown>> | undefined {
  const attachments = [
    ...strIds(m.AttachmentFileIds).map((id) => ({ type: 'file', id })),
    ...strIds(m.AttachmentContentIds).map((id) => ({ type: 'content', id })),
  ];

  return attachments.length > 0 ? attachments : undefined;
}

// Recipients for participants_metadata.to. Sources record recipients under To /
// Recipient / Recipients (email To header, SMS To, etc.); an email To header is
// a comma-separated list, so split + de-dup into the array shape the contract
// expects. iMessage and other multi-party sources hand us a pre-resolved array
// of handles, which goes in as-is. Leaves toEntityIds unset — the server
// resolves these raw strings.
function recipientsFrom(m: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const pushOne = (raw: string) => {
    const v = raw.trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  };

  const push = (val: unknown) => {
    if (Array.isArray(val)) {
      for (const v of val) {
        if (typeof v === 'string') {
          pushOne(v);
        }
      }

      return;
    }

    const s = str(val);
    if (!s) {
      return;
    }

    for (const part of s.split(',')) {
      pushOne(part);
    }
  };

  push(m.To);
  push(m.Recipient);
  push(m.Recipients);

  return out;
}

/* -------------------------------------------------------------------------- *
 * Facebook Messenger communications.
 *
 * Messenger messages get a Messenger-specific contract on top of the generic
 * communication path: thread_id is the Messenger group name ('Conversation' in
 * the JSON path, 'Thread' in the HTML path), direction is decided by
 * fuzzy-matching the sender against the CI-Server user behind the push
 * credentials, and the provenance triple is
 * ('import', 'facebook_messenger', <message item id>) — NOT the generic
 * (SOURCE_TYPE, data_source, id) triple.
 *
 * Participants ship as raw display names in participants_metadata
 * ({from: string, to: [string]} — the shape CI-Server's participant-link
 * maintenance reads). Person rows are created and linked SERVER-SIDE by the
 * extract_people / link maintenance legs; the importer never calls
 * createPeople and leaves from_entity_id / to_entity_ids unset.
 * -------------------------------------------------------------------------- */

/** source_system for Messenger communications (distinct from posts/media). */
export const FACEBOOK_MESSENGER_SOURCE_SYSTEM = 'facebook_messenger';
/** source_type for Messenger communications. */
export const FACEBOOK_MESSENGER_SOURCE_TYPE = 'import';

/** Is this canonical record a Facebook Messenger message? */
export function isFacebookMessengerRecord(rec: CanonicalRecord): boolean {
  return rec.sourceSystem === 'facebook' && rec.kind === 'communication.message';
}

/** The sender + recipient display names of a Messenger message. */
export function messengerParticipantsOf(rec: CanonicalRecord): {
  sender: string | null;
  recipients: string[];
} {
  const m = rec.metadata;

  return { sender: str(m.Sender) || str(m.From) || str(m.Contact), recipients: recipientsFrom(m) };
}

/**
 * Map a Facebook Messenger record to a CreateCommunicationDto. Direction:
 * sender ≈ the API key's user → outgoing, else incoming — expressed as
 * CI-Server's 'outbound'/'inbound' (the ci.communication_direction Postgres
 * enum has no outgoing/incoming spellings, and the resolver stores the value
 * verbatim).
 */
export function toFacebookMessengerCommunicationInput(
  rec: CanonicalRecord,
  /** Does this sender display name fuzzy-match the CI-Server user? */
  isSelf: (name: string) => boolean,
): CreateCommunicationDto {
  const m = rec.metadata;
  // rec.title's only fallback for a Messenger record is the synthesized
  // "Message — <sender>" display label (push/canonical.ts titleFor's sender
  // branch) — never real message text. Falling back to it here contradicted
  // facebook.ts's own contract ("Media-only messages persist with empty
  // content — the message IS its attachments").
  const content = rec.description ?? '';
  const { sender, recipients } = messengerParticipantsOf(rec);
  const input: CreateCommunicationDto = {
    communication_type: CommunicationType.CHAT,
    time: new Date(rec.startTime),
    content,
    direction: sender && isSelf(sender) ? 'outbound' : 'inbound',
    source_type: FACEBOOK_MESSENGER_SOURCE_TYPE,
    source_system: FACEBOOK_MESSENGER_SOURCE_SYSTEM,
    source_id: rec.sourceId,
  };
  const preview = content ? clip(content, 140) : null;
  if (preview && preview !== content) {
    input.preview = preview;
  }

  // Chat messages have no natural subject line — none is synthesized. Readers
  // fall back to preview/content (CI-Server derives preview from content when
  // absent), so lists/search still show the message body.
  // The Messenger group name: 'Conversation' (JSON export) / 'Thread' (HTML).
  const thread = str(m.Conversation) || str(m.Thread);
  if (thread) {
    input.thread_id = thread;
  }

  // Raw names in the string shape the server-side participant linker reads;
  // it resolves them to Person rows and fills the entity-id columns there.
  const participants: Record<string, unknown> = {};
  if (sender) {
    participants.from = sender;
  }

  if (recipients.length) {
    participants.to = recipients;
  }

  if (Object.keys(participants).length) {
    input.participants_metadata = participants;
  }

  // Photos/videos/gifs/audio the message carried, as { type, id } refs to the
  // stored files and their content rows — see attachmentsFor. A media-only
  // message has empty `content` and lives entirely in here.
  const attachments = attachmentsFor(m);
  if (attachments) {
    input.attachments = attachments;
  }

  return input;
}

/** source_system for WhatsApp communications. */
export const WHATSAPP_SOURCE_SYSTEM = 'whatsapp';

/** Is this canonical record a WhatsApp chat message? */
export function isWhatsAppRecord(rec: CanonicalRecord): boolean {
  return rec.sourceSystem === WHATSAPP_SOURCE_SYSTEM && rec.kind === 'communication.message';
}

/**
 * Map a WhatsApp record to a CreateCommunicationDto. `_chat.txt` exports are
 * a flat transcript with no built-in "this one is me" signal — unlike
 * iMessage's `is_from_me` column or SMS Backup & Restore's type code, the
 * account owner is just another `Sender` display name — so direction can't be
 * read off the source data the way `directionFor` does for other messengers.
 * Resolved the same way as Facebook Messenger: fuzzy-match the sender against
 * the CI-Server user behind the push credentials.
 */
export function toWhatsAppCommunicationInput(
  rec: CanonicalRecord,
  isSelf: (name: string) => boolean,
): CreateCommunicationDto {
  const input = toCommunicationInput(rec);
  const sender = str(rec.metadata.Sender);
  input.direction = sender && isSelf(sender) ? 'outbound' : 'inbound';
  // thread_id needs no override here any more: `Conversation` — the chat name
  // the WhatsApp importer stamps — is now part of toCommunicationInput's own
  // fallback chain. Direction is the only thing this wrapper still decides.

  return input;
}

// Importer direction vocabulary -> CI-Server inbound/outbound. Messages record
// `From Me` (boolean) rather than a direction string; honour both. Call records
// may carry missed/voicemail/rejected/refused/unknown — all inbound.
function directionFor(m: Record<string, unknown>): 'inbound' | 'outbound' | null {
  const raw = str(m.direction) || str(m.Direction);
  if (raw) {
    const lc = raw.toLowerCase();
    if (lc === 'outgoing' || lc === 'sent' || lc === 'outbound') {
      return 'outbound';
    }

    // Everything else — incoming, received, inbound, missed, voicemail, rejected,
    // refused, unknown — is inbound.
    return 'inbound';
  }

  if (typeof m['From Me'] === 'boolean') {
    return m['From Me'] ? 'outbound' : 'inbound';
  }

  return null;
}

/**
 * Map a `web.page_view` / `web.bookmark` record to a CreateBrowserActivityDto.
 * URL + Title come from metadata (Chromium and Firefox both use URL/Title);
 * actionType distinguishes a bookmark from a plain visit. Firefox's importer
 * also persists a `Description` per row (1.3k of 3k rows had one in the live
 * dataset) — surface it to pageSummary and pass the full metadata bag through
 * to properties so the importer stops dropping correctly-parsed fields.
 */
export function toBrowserActivityInput(rec: CanonicalRecord): CreateBrowserActivityDto {
  const m = rec.metadata;
  const input: CreateBrowserActivityDto = {
    time: rec.startTime,
    // A search often has no page URL; its query is the identity. Fall back to the
    // query (Search/Query metadata or the record title) so url is never empty.
    url:
      str(m.URL) ||
      str(m.Url) ||
      str(m.url) ||
      (rec.kind === 'web.search' ? str(m.Search) || str(m.Query) || str(m.query) : '') ||
      rec.title ||
      '',
    action_type:
      rec.kind === 'web.bookmark'
        ? 'bookmark'
        : rec.kind === 'web.search'
          ? 'search'
          : rec.kind === 'web.download'
            ? 'download'
            : 'visit',
    properties: m,
    ...sourceTriple(rec),
  };
  const title = str(m.Title) || rec.title;
  if (title) {
    input.title = title;
  }

  const summary = rec.description || str(m.Description);
  if (summary) {
    input.page_summary = summary;
  }

  // Dwell time. `ci.browser_activity.duration_seconds`, this DTO field and the
  // `screen_minutes` daily metric that sums it were all in place with no
  // producer on any import path — the only other assignment of this column
  // (above) is a COMMUNICATION's call duration, so browser rows never carried
  // one. The parser decides what counts as a usable duration and omits the
  // field otherwise (see chromium.ts dwellSeconds); this only passes through a
  // positive finite number.
  const dwell = Number(m.DurationSeconds);
  if (Number.isFinite(dwell) && dwell > 0) {
    input.duration_seconds = dwell;
  }

  return input;
}

// CanonicalRecord locationSource -> CI-Server's ci.location_source enum. EXIF
// GPS came off a GPS receiver originally, so it lands as 'gps'. A textual
// address that the server forward-geocodes is much weaker than any direct
// fix — 'other' is the closest pre-existing bucket ('inferred' is reserved for
// LocationEstimateService's own output).
const POSITION_SOURCE_BY_LOCATION_SOURCE: Record<
  NonNullable<CanonicalRecord['locationSource']>,
  CreatePositionDto['source']
> = {
  gps: 'gps',
  exif: 'gps',
  address: 'other',
  wifi: 'wifi',
};

// Two signed decimals separated by a comma. Shared by both arms of
// isCoordinateText below, and mirrored in SQL by the two backfills that recover
// rows written before each arm existed:
// db/postgres/migrations/20260818212254_backfill_position_coordinate_names.sql
// (bare) and 20260818235752_backfill_position_non_place_names.sql (labelled).
const COORDINATE_PAIR = String.raw`[-+]?\d{1,3}(?:\.\d+)?\s*,\s*[-+]?\d{1,3}(?:\.\d+)?`;

// A closed vocabulary of GENERIC geolocation nouns — words that mean "a point
// on the earth" and nothing more specific. Deliberately not a venue vocabulary:
// "Cafe", "Pier", "Park" are absent, so a real place whose name happens to be
// followed by numbers is never swallowed by the label arm.
const GEO_LABEL = String.raw`(?:location|position|coordinates?|coords?|point|waypoint|fix|gps)`;

// `[-:]` and not `[:-]`: the same two characters, ordered so the SQL twin of
// this pattern in the backfill migration cannot be misread as the start of a
// POSIX character-class name (`[:alpha:]`).
const COORDINATE_TEXT = new RegExp(String.raw`^\s*(?:${GEO_LABEL}\s*[-:]?\s*)?${COORDINATE_PAIR}\s*$`, 'i');

/**
 * Is this string just a coordinate pair — "33.51469, -117.72169" — or the same
 * pair wearing a generic label, "Location 33.51469, -117.72169"?
 *
 * Deliberately narrow: two signed decimals separated by a comma and nothing
 * else, optionally preceded by ONE generic geolocation noun. "Cafe 40.7, 74.0"
 * keeps its name, because a place whose name happens to contain numbers is
 * still a name and "Cafe" is not a word that means "a point on the earth".
 *
 * The label arm is not hypothetical. The original anchor (`^\s*[-+]?\d`)
 * required the string to START with the number, so every labelled variant
 * sailed through untouched: `google_location`, `kmlgx` and `nmea` each
 * manufactured `Location ${lat.toFixed(5)}, ${lon.toFixed(5)}` and it landed in
 * `ci.position.name` exactly like google_fit's bare pair did. Those three no
 * longer mint the string at all (that is the real fix — see each datasource),
 * but this stays the structural backstop: an importer we do not control, a
 * third-party export, or a re-import of already-corrupted data can all present
 * the same shape, and the guard should not depend on owning every producer.
 */
export function isCoordinateText(value: string): boolean {
  return COORDINATE_TEXT.test(value);
}

// Extensions of things that are FILES, not places. Any name ending in one of
// these is a media filename that rode in as the item's display title. Mirrored
// in SQL by 20260818235752_backfill_position_non_place_names.sql.
const MEDIA_EXTENSION = /\.(?:jpe?g|png|heic|heif|gif|mov|mp4|m4v|avi|webp|dng|tiff?)$/i;

// A bare UUID stem, with or without Apple's `_N` burst/segment suffix
// ("A20CEAAC-8F30-403E-A17B-E60DBC744DBB_3"). Same defect one step further
// along: an export that strips the extension leaves an opaque identifier that
// is even less of a place name than the filename it came from.
const BARE_UUID_STEM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[_-]\d+)?$/i;

/**
 * Is this string a media filename rather than a place name — "IMG_0139.JPG",
 * "A20CEAAC-8F30-403E-A17B-E60DBC744DBB_3.mov"?
 *
 * Every GPS-bearing photo donates a position row, and `titleFor` gives a
 * `capture.*` item its filename as a display title (correctly — that is the
 * only label a photo has). `toPositionInput` then read that title as the
 * position's NAME, so 2,085 rows on a real appliance had a filename where the
 * place should be, and the Places view rendered them as such.
 *
 * Structural like its two neighbours: a file extension / opaque identifier
 * grammar, not a per-importer denylist, so a camera roll from a source we have
 * never seen is caught too.
 */
export function isMediaFilename(value: string): boolean {
  const trimmed = value.trim();

  return MEDIA_EXTENSION.test(trimmed) || BARE_UUID_STEM.test(trimmed);
}

// The character `clip` (push/canonical.ts) appends when it truncates. Nothing
// else in the import pipeline emits U+2026, so a trailing one is a receipt: the
// value is the first 79/119 characters of something longer, not a whole label.
const CLIP_ELLIPSIS = '…';

// Sentence-terminal punctuation. `!` and `?` only, and deliberately NOT `.`:
// real place names carry dots — 'A.G. Bartlett Building' and 'Bongeunsa Temple.
// Lotte Duty Free Shop' are both live on the corpus — while of the 2,428
// distinct ci.position.name values there, the only two carrying a bang or a
// query mark are the geotagged tweets this arm exists for. `@` is out for the
// same reason: 'On Jane Stanford Way @ Gilbert Biological Sciences' is a real
// transit stop.
const SENTENCE_PUNCTUATION = /[!?]/;

// A place name is a noun phrase, and a fully-qualified one is bounded: venue,
// street, city, state, ZIP, country. Measured over every distinct non-blank
// ci.position.name on the corpus, the longest GENUINE name is 14 words — 'Red
// Roof PLUS+ Boston - Framingham, 650 Cochituate Rd, Framingham, MA 01701,
// United States' — and the shortest narration surviving the two arms above is
// 16. The bound is in WORDS and not characters because at 90 characters the two
// classes interleave (an 89-character 'Uber ride from … (request)' is SHORTER
// than that 90-character hotel) and at 14 words they do not.
const MAX_PLACE_NAME_WORDS = 14;

/**
 * Is this string a TITLE — a message body, a social post, a page headline, a
 * narration — rather than the name of a place?
 *
 * The fifth upstream of `ci.position.name`, and the one none of the arms above
 * could see. `titleFor` (push/canonical.ts) gives every record a display label,
 * and for a geotagged message, tweet or trip that label is body text or a
 * sentence about what happened. `toPositionInput` read it as the place name, so
 * `promote.place_position` minted a Location entity per snippet and the Places
 * list filled with "Check out a replay of BitScoop Labs' first live stream!
 * #BitScoop…" and "Uber ride from 110 E 30th St, Austin, TX 78705, US to 101 Red
 * River St, Austin, TX 78701, US (request)" — 44 of the 203 named positions on
 * the corpus at the time of measurement.
 *
 * Three structural arms, in ascending order of what they assume:
 *
 *  1. It ends in the clip ellipsis. That character is `clip`'s truncation mark
 *     and nothing else writes it, so the value is a PREFIX of a longer text. A
 *     truncated string cannot be a place's name even when the place is real — it
 *     will not geocode, and it forks the entity graph against the full name.
 *  2. It contains `!` or `?`. A name neither exclaims nor asks.
 *  3. It runs longer than any place name observed, in words. See
 *     {@link MAX_PLACE_NAME_WORDS}.
 *
 * A grammar rather than a denylist, same as its three neighbours: these shapes
 * hold for a Facebook check-in body and a Strava note from importers that do not
 * exist yet, where `/^Uber ride from /` would hold for exactly one producer.
 *
 * The asymmetry that justifies the tight word bound: a false REJECT costs a name
 * that the reverse-geocoder then supplies from the coordinates the row already
 * has, while a false ACCEPT is a permanent Location entity named after a
 * sentence.
 */
export function isTitleText(value: string): boolean {
  const trimmed = value.trim();

  return (
    trimmed.endsWith(CLIP_ELLIPSIS) ||
    SENTENCE_PUNCTUATION.test(trimmed) ||
    trimmed.split(/\s+/).length > MAX_PLACE_NAME_WORDS
  );
}

/**
 * The four structural rejects, read as one rule: a coordinate pair, a URI, a
 * media filename and a title/body snippet are each provably NOT the name of a
 * place, whatever slot the importer put them in.
 *
 * Rejecting leaves `ci.position.name` NULL, which is the point — a null name is
 * what makes the row a candidate for the reverse-geocoder to fill with a real
 * one. A fake name is strictly worse than no name: it displays as though the
 * place were already known.
 *
 * Mirrored into SQL by `NOT_A_PLACE_NAME_SQL`
 * (domains/pipeline/stages/promote/PositionPlacePromoteStage.ts), which gates
 * the same column for rows written before this guard existed. The two must not
 * drift — an arm added here needs its twin there.
 */
export function isNotAPlaceName(value: string): boolean {
  return isCoordinateText(value) || isUriLocation(value) || isMediaFilename(value) || isTitleText(value);
}

/**
 * Map a canonical record to a CreatePositionDto. Called for the `position`
 * partition produced by destinationsFor (raw GPS, place visits, GPS-bearing
 * photos). Skips records without coordinates by returning null — those have
 * nothing useful to donate to the location estimator.
 */
export function toPositionInput(rec: CanonicalRecord): CreatePositionDto | null {
  if (!rec.coordinates) {
    return null;
  }

  const m = rec.metadata;
  const input: CreatePositionDto = {
    time: rec.startTime,
    // `location` is a plain {x, y} on this DTO — x is LONGITUDE, y is latitude,
    // the order PostGIS uses and the reverse of how coordinates are spoken.
    location: { x: rec.coordinates.lon, y: rec.coordinates.lat },
    // Default to 'gps' for any coord-bearing record whose source we didn't
    // classify (locationSource undefined) — the position table requires a
    // non-null source and gps is the safest catch-all for a real coordinate.
    source: rec.locationSource ? POSITION_SOURCE_BY_LOCATION_SOURCE[rec.locationSource] : 'gps',
    ...sourceTriple(rec),
  };
  if (rec.accuracyMeters != null && rec.accuracyMeters > 0) {
    input.accuracy_meters = rec.accuracyMeters;
  }

  const altitude = num(m.Altitude) ?? num(m.altitude) ?? num(m.Elevation) ?? num(m.elevation);
  if (altitude != null) {
    input.altitude_meters = altitude;
  }

  const hdop = num(m.HDOP) ?? num(m.hdop);
  if (hdop != null) {
    input.hdop = hdop;
  }

  const vdop = num(m.VDOP) ?? num(m.vdop);
  if (vdop != null) {
    input.vdop = vdop;
  }

  const heading = num(m.Heading) ?? num(m.heading);
  if (heading != null) {
    input.heading_degrees = heading;
  }

  const speed = num(m.Velocity) ?? num(m.Speed) ?? num(m.speed);
  if (speed != null) {
    input.speed_meters_per_second = speed;
  }

  const address = rec.locationName ?? str(m.Address) ?? str(m.address);
  if (address) {
    input.address = address;
  }

  // Prefer a human title over the empty default so a position row keeps a
  // readable label when viewed in isolation — but a COORDINATE PAIR, A URI, A
  // MEDIA FILENAME, OR A SENTENCE RENDERED AS TEXT IS NOT A NAME. See
  // isNotAPlaceName.
  //
  // It is the geometry this row already stores, and writing it into `name`
  // makes the row look already-named to everything downstream. The
  // reverse-geocode candidate filter is "coordinates present, name missing", so
  // a coordinate-named row is never a candidate: on a real Google Takeout,
  // 62,832 of 62,833 positions arrived named `"33.51469, -117.72169"` from
  // google_fit's trackpoints, none was ever offered to the geocoder, and the
  // Places view held exactly one entry — the single row that came from Maps
  // saved places with a real name ("Gym").
  //
  // google_fit is careful about this in `Name` (undefined for trackpoints, set
  // for waypoints) and then loses it in `Title`, which falls back to the
  // coordinates for the item's DISPLAY label. That fallback is right for a
  // title and wrong for a place name, so the filtering belongs here, where the
  // two meanings separate — and it holds for any importer that titles a fix
  // with its own coordinates.
  //
  // The same split explains the media-filename arm: `titleFor` gives a
  // GPS-bearing photo its filename as a display title, which is the right title
  // and the wrong place name. 2,085 positions on a real appliance read
  // "IMG_0139.JPG" where the place should be. And the title arm
  // (`isTitleText`), for the same reason one step further out: a geotagged
  // tweet's display title is its body text.
  // The record's OWN staged filename is never its place name. `titleFor` falls
  // back to `basename(row.filename)` when a record carries no title-worthy
  // metadata (canonical.ts), so removing a datasource's manufactured pseudo-name
  // does not leave the slot empty — it lets the file's name slide into it:
  // google_location's `Records.json` fixes would read 'location.txt', kmlgx
  // '<file>.kml', nmea '<file>.nmea', and gpx already writes 'track.gpx' on main
  // for any nameless trkpt. An extension allowlist cannot catch that class,
  // because the extension is whatever the export happened to use. Comparing
  // against the filename canonical.ts:1001 already stamped catches all of them.
  const stagedName = str(m.filename);
  const stagedBasename = stagedName?.split('/').pop()?.trim();

  // WHICH SLOTS may hold a place name, decided by what the record IS.
  //
  // The shape guard above says what a place name cannot LOOK like; this says
  // where one can come FROM, and it is the arm that does not depend on guessing
  // prose from a string. `location.fix` is the only kind whose subject is a
  // point on the earth, and `titleFor` gives such a record a place-derived title
  // (Name/Place/Venue/Address — canonical.ts). Every OTHER kind that reaches the
  // position partition rode in because it happened to carry coordinates: a
  // geotagged message, a geotagged tweet, a located search, a GPS-bearing photo.
  // Their `title` is the message body, the post text, the query, or the
  // filename — a label for the RECORD, never for the ground under it.
  //
  // `Name` stays readable for every kind because it is the one key that MEANS a
  // name: an importer filling it on a photo is stating "this fix is at a place
  // called X", which is exactly the claim `name` records. `Title` is a display
  // label and gets the same treatment as `rec.title`.
  const namesAPlace = rec.kind === 'location.fix';
  const candidates = namesAPlace ? [rec.title, str(m.Name), str(m.Title)] : [str(m.Name)];

  const name = candidates.find(
    (candidate): candidate is string =>
      candidate != null &&
      candidate !== '' &&
      !isNotAPlaceName(candidate) &&
      !(stagedBasename != null && stagedBasename !== '' && candidate.trim() === stagedBasename),
  );

  if (name) {
    input.name = name;
  }

  const description = rec.description ?? str(m.Description);
  if (description) {
    input.description = description;
  }

  const provider = str(m.Source) ?? rec.sourceSystem;
  if (provider) {
    input.provider = provider;
  }

  const activity = str(m['Activity Type']) ?? str(m.ActivityType) ?? str(m.activityType);
  if (activity) {
    input.activity_type = activity;
  }

  return input;
}

/**
 * One CreateContentDto per attachment link on a Discord message — a link row
 * and nothing more.
 *
 * `type` follows the same rule a drive walk uses for a real file
 * (timeline.mediaItemFromFile): a media MIME is 'media', everything else is the
 * honest 'file'. `title` is the uploaded filename the URL ends in — the one
 * human-readable string the package carries about the file itself. Still no
 * text: the only candidate would be the caption of the message it was posted
 * with, which describes the message, not the file. An extension mime-db can't
 * type at all (Discord uploads include bare `env` / `config` files) stays
 * 'file' with no mimetype — no type beats a wrong one.
 *
 * Each row takes the message's provenance triple with an `:attachment:<n>`
 * suffix on the sourceId, so it dedups server-side across re-imports and keeps
 * a stable identity per link.
 */
export function discordAttachmentContentInputs(rec: CanonicalRecord): CreateContentDto[] {
  return discordAttachmentUrls(rec).map((url, i) => {
    const filename = discordAttachmentFilename(url);
    const mimetype = filename ? mimeForFile(filename) : undefined;
    const input: CreateContentDto = {
      type: isMediaType(mimetype ?? null) ? 'media' : 'file',
      url,
      source_type: rec.sourceType,
      source_system: rec.sourceSystem,
      source_id: `${rec.sourceId}:attachment:${i}`,
    };
    if (filename) {
      input.title = filename;
    }

    if (mimetype) {
      input.mimetype = mimetype;
    }

    return input;
  });
}

/**
 * Map a record to the event a timeline shows.
 *
 * Ported from upstream's GraphQL encoder rather than from `mapping.ts` — events
 * were the one destination whose input never lived beside the others, because
 * they rode a different endpoint. In-process that distinction is gone, so it
 * belongs here with the rest.
 *
 * Fields with no first-class column ride in `metadata` so they survive the
 * round-trip. The GPS provenance pair is deliberately duplicated there as well
 * as on the position row: `LocationEstimateService` reads accuracy and source
 * when weighing donors, and an event whose position leg was skipped would
 * otherwise carry a coordinate with no indication of how good it is.
 */
export function toEventInput(rec: CanonicalRecord): CreateEventDto {
  const metadata: Record<string, unknown> = { ...rec.metadata };

  if (rec.mediaType) {
    metadata.mediaType = rec.mediaType;
  }

  // ── The record's source gave it no time ──────────────────────────────────
  //
  // `ci.events.start_time` is NOT NULL, so `toCanonical` fell back to the
  // staged row's own created_at — the import wall clock. There is no date to
  // recover and no way to store "none", so the only honest thing left is to say
  // so ON the row, at the moment it is minted.
  //
  // Two channels, deliberately, because they have different readers:
  //
  //  - `time_source` / `time_precision` are the FIRST-CLASS columns, and their
  //    vocabulary is not ours: it is declared once in
  //    pipeline/stages/clean/TemporalRepairStage (TIME_SOURCES /
  //    TIME_PRECISIONS) and mirrored here rather than imported, because the
  //    import domain has no other dependency on the pipeline domain and one
  //    string pair is not worth minting one. `undatedRecords.test.ts` asserts
  //    the two literals still equal the constants, so the mirror cannot drift
  //    silently.
  //  - `metadata.undated` is the same fact on a field the read path ALREADY
  //    exposed (`EventType.metadata` is a GraphQLJSONObject) before
  //    `EventType.timeSource` existed as its own field. `timeSource` is now
  //    exposed too (domains/graphql/types/EventType.ts) and is what the web
  //    client actually reads (Components/utils.tsx getEntityTimestamp) — this
  //    key is kept for any consumer still reading it, not as the only way in.
  //
  // Why stamp it here rather than let TemporalRepairStage discover it: that
  // stage can only label a source it has a declared SourceTimeSpec for, and
  // only after a sweep has visited the row. Between the import and the sweep —
  // and forever, for any source with no spec — the row is indistinguishable
  // from one whose export really did say "now". The transform is the only place
  // that KNOWS, because it is the thing doing the substituting. The stage stays
  // the owner of `repaired` and the `*_original` pair; this is only the
  // negative assertion it would otherwise have to re-derive.
  if (!rec.dated) {
    metadata.undated = true;
  }

  if (rec.contentHash) {
    metadata.contentHash = rec.contentHash;
  }

  if (rec.accuracyMeters != null) {
    metadata.accuracyMeters = rec.accuracyMeters;
  }

  if (rec.locationSource) {
    metadata.locationSource = rec.locationSource;
  }

  const input: CreateEventDto = {
    // `title` is required here where upstream left it optional. A record with
    // nothing to call it is still worth a timeline row, so it falls back to the
    // kind — an honest "a photo happened" beats an empty title on the timeline.
    title: rec.title ?? rec.kind,
    start_time: new Date(rec.startTime),
    // See the `!rec.dated` block above. ONLY the negative assertion is stamped;
    // a dated row is left NULL rather than claimed as `source`.
    //
    // That asymmetry is deliberate and it is the safer half of this change.
    // `dated` means only "the parser produced a non-null instant", which is a
    // weaker claim than TIME_SOURCES.SOURCE ("the source supplied this instant
    // and it survived ingest intact") — a parser that FABRICATES an instant
    // (nmea.ts used to fill a dateless GGA sentence in with today's date)
    // satisfies the first and violates the second. Stamping `source` on the
    // strength of non-nullness would launder exactly that bug into a provenance
    // claim, and it would switch off the structural arm of the
    // `events-timestamped-at-import` doctor check for every imported row, since
    // that check excludes `time_source = 'source'` as its legitimate-shape
    // escape hatch. NULL keeps meaning "unexamined", which is what
    // TemporalRepairStage and the doctor both already assume.
    ...(rec.dated ? {} : { time_source: UNDATED_TIME_SOURCE, time_precision: UNDATED_TIME_PRECISION }),
    metadata,
    ...sourceTriple(rec),
  };

  if (rec.endTime) {
    input.end_time = new Date(rec.endTime);
  }

  // Sources that know a duration outright (an Uber ride's trip_duration_seconds)
  // publish it as whole minutes.
  const minutes = Number(metadata['Duration (minutes)']);

  if (Number.isFinite(minutes) && minutes >= 0) {
    input.duration_minutes = Math.round(minutes);
  }

  if (rec.eventType) {
    input.event_type = rec.eventType;
  }

  if (rec.category) {
    input.category = rec.category;
  }

  if (rec.description) {
    input.description = rec.description;
  }

  // A meeting-join link ("https://khronosgroup.zoom.us/w/99353948195?tk=…") or
  // a custom-scheme URI ("altspace://account.altvr.com/api/events/…") is not a
  // place name — see isUriLocation for why this is a structural check rather
  // than a per-app denylist, matching isCoordinateText above.
  if (rec.locationName && !isUriLocation(rec.locationName)) {
    input.location_name = rec.locationName;
  }

  if (rec.isAllDay != null) {
    input.is_all_day = rec.isAllDay;
  }

  if (rec.isRecurring != null) {
    input.is_recurring = rec.isRecurring;
  }

  if (rec.coordinates) {
    input.location_coordinates = {
      type: 'Point',
      coordinates: [rec.coordinates.lon, rec.coordinates.lat],
    };
  }

  return input;
}
