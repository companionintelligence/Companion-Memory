/* Uber — CSV export (an Uber privacy-export ZIP).
 *
 * Handles BOTH the trip-history schemas Uber has shipped AND Uber Eats orders:
 *   - Trips, current:  `Uber Data/Rider/trips_data-0.csv` (partitioned `-N`),
 *     snake_case columns (begintrip_timestamp_utc, begintrip_lat, fare_amount, …),
 *     ISO-8601 timestamps.  -> one 'trip' item, plus a 'location' item for each
 *     of the request/pickup/dropoff fixes. Cancelled rides are skipped.
 *   - Trips, legacy:   `Trip Data/trips_data.csv`, Title-Case columns
 *     (Begin Trip Time, Begin Trip Lat, Fare Amount, …), "… +0000 UTC".
 *   - Eats:            `Uber Data/Eats/user_orders-0.csv`, one row per line item;
 *     grouped into orders by (request time, restaurant). -> classification 'transaction',
 *     plus one 'food' entity per line item, linked to the order by an `includes` edge.
 *     Cancelled orders are skipped, as cancelled rides are.
 * Trip column reads go through `pick()` which tries both name styles, so one code
 * path serves both trip schemas. */
import fs from 'node:fs';
import { open, readdir, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { parseCSV } from './csv';
import type { FileImporter, Recognition, DirEntry } from './registry';
import { registerDataSource } from './registry';
import type { ImportParams, LineItemRecord, Relationship } from './timeline';
import { timeframeContains } from './timeline';

// First non-empty value among the candidate column names (new + legacy styles).
function pick(row: Record<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== '') {
      return v;
    }
  }

  return '';
}

// Accepts ISO-8601 ("2019-01-16T11:33:09.000Z", current export) and the legacy
// "YYYY-MM-DD HH:MM:SS +0000 UTC" form.
function parseUberDate(s: string): Date | undefined {
  if (!s) {
    return undefined;
  }

  const direct = new Date(s);
  if (!isNaN(direct.getTime())) {
    return direct;
  }

  const cleaned = s.replace(/ UTC$/, '').replace(' ', 'T').replace(' ', '');
  const d = new Date(cleaned);

  return isNaN(d.getTime()) ? undefined : d;
}

// Signature columns of either trip schema, used to recognise a trips CSV.
function headerHasTripCols(text: string): boolean {
  const nl = text.indexOf('\n');
  const header = (nl === -1 ? text : text.slice(0, nl)).toLowerCase();

  return header.includes('begintrip_lat') || header.includes('begin trip lat');
}

// A price cell as a number, for the comparisons the value exists to serve
// ("what's the most I've paid for this?"). A cell that isn't a number is kept
// verbatim instead — an unparseable price is still a record of something, and
// dropping it would quietly lose an order entry.
function parsePrice(v: string): number | string {
  const n = Number(v);

  return Number.isFinite(n) ? n : v;
}

// Parse a CSV coordinate cell to a finite number, or undefined when blank/junk.
function parseCoord(v: string | undefined): number | undefined {
  if (!v) {
    return undefined;
  }

  const n = parseFloat(v);

  return Number.isFinite(n) ? n : undefined;
}

const TRIPS_FILE_RE = /^trips_data(-\d+)?\.csv$/i;
const EATS_FILE_RE = /^user_orders(-\d+)?\.csv$/i;

// Recursively collect every CSV matching `re` under a directory (bounded depth;
// Uber exports are small and nest files at Uber Data/<Rider|Eats>/<file>).
async function findCsvFiles(root: string, re: RegExp, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth) {
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, depth + 1);
      } else if (e.isFile() && re.test(e.name)) {
        out.push(full);
      }
    }
  };

  await walk(root, 0);

  return out.sort();
}

export class UberFileImporter implements FileImporter {
  async recognize(_ctx: unknown, entry: DirEntry): Promise<Recognition> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return { confidence: 0 };
    }

    let stat: fs.Stats;
    try {
      stat = await fsStat(root);
    } catch {
      return { confidence: 0 };
    }

    if (stat.isFile()) {
      const base = path.basename(root);
      if (TRIPS_FILE_RE.test(base)) {
        return (await this.headerMatches(root)) ? { confidence: 0.95 } : { confidence: 0.8 };
      }

      if (EATS_FILE_RE.test(base)) {
        return { confidence: 0.85 };
      }

      return { confidence: 0 };
    }

    if (stat.isDirectory()) {
      const trips = await findCsvFiles(root, TRIPS_FILE_RE);
      if (trips.length) {
        for (const f of trips) {
          if (await this.headerMatches(f)) {
            return { confidence: 0.95 };
          }
        }

        return { confidence: 0.8 };
      }

      if ((await findCsvFiles(root, EATS_FILE_RE)).length) {
        return { confidence: 0.85 };
      }

      return { confidence: 0, dir_threshold: 0.7 };
    }

    return { confidence: 0 };
  }

  private async headerMatches(fpath: string): Promise<boolean> {
    try {
      const fh = await open(fpath, 'r');
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await fh.read(buf, 0, 4096, 0);

        return headerHasTripCols(buf.toString('utf8', 0, bytesRead));
      } finally {
        await fh.close().catch(() => {});
      }
    } catch {
      return false;
    }
  }

  async fileImport(_ctx: unknown, entry: DirEntry, params: ImportParams): Promise<void> {
    const root = entry.fullPath || entry.fsRoot || entry.filename;
    if (!root) {
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(root);
    } catch {
      return;
    }

    let tripFiles: string[];
    let eatsFiles: string[];
    if (stat.isFile()) {
      const base = path.basename(root);
      tripFiles = TRIPS_FILE_RE.test(base) ? [root] : [];
      eatsFiles = EATS_FILE_RE.test(base) ? [root] : [];
    } else {
      tripFiles = await findCsvFiles(root, TRIPS_FILE_RE);
      eatsFiles = await findCsvFiles(root, EATS_FILE_RE);
    }

    if (!tripFiles.length && !eatsFiles.length) {
      params.log?.('error', 'Uber: no trips_data*.csv or user_orders*.csv found', { root });

      return;
    }

    for (const f of tripFiles) {
      await this.processTripsFile(f, params);
    }

    for (const f of eatsFiles) {
      await this.processEatsFile(f, params);
    }
  }

  private async processTripsFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    if (!rows.length) {
      params.log?.('warn', `Uber: ${base} parsed 0 rows`);
    }

    for (const row of rows) {
      try {
        this.pushTrip(row, params);
      } catch (e) {
        params.log?.('error', `Failed to import row in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushTrip(row: Record<string, string>, params: ImportParams): void {
    const status = pick(row, 'status', 'Trip or Order Status');
    // A ride that never happened is not a trip. Uber spells the status several
    // ways (canceled / CANCELED / driver_canceled / rider_canceled), so match on
    // the stem rather than an exact value. Reported, not silently dropped.
    if (/cancel/i.test(status)) {
      params.pipeline.drop?.('cancelled_trip', status);

      return;
    }

    // Where you were standing when you opened the app, which is NOT where the
    // ride began: across an 81-row export the request preceded the pickup by 61s
    // to 28min (median 5.6min), and the two fixes sit up to a block apart. The
    // column is also newer than the account — only 38 of those 81 rows carry it,
    // so its absence is normal and silent rather than a defect.
    const requestTsRaw = pick(row, 'request_timestamp_utc', 'Request Time');
    const requestTs = parseUberDate(requestTsRaw);
    const request = this.coordsOf(row, 'request_lat', 'Request Lat', 'request_lng', 'Request Lng');

    // The ride begins when the driver starts the trip. Where the export has no
    // pickup copy, the request stands in for it: the request goes out shortly
    // before the pickup even for a ride booked days ahead, so it dates and
    // places the ride within minutes rather than stretching it back to wherever
    // you happened to be when you scheduled it. Cancelled rows — the ones that
    // only ever had a request time — are already gone by here.
    const tsRaw = pick(row, 'begintrip_timestamp_utc', 'Begin Trip Time');
    const ts = parseUberDate(tsRaw) ?? requestTs;
    if (!ts) {
      params.pipeline.drop?.('trip_without_start_time', pick(row, 'begintrip_address', 'Begin Trip Address'));

      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const dropoffTs = parseUberDate(pick(row, 'dropoff_timestamp_utc', 'Dropoff Time'));
    const seconds = Number(pick(row, 'trip_duration_seconds', 'Trip Duration (seconds)'));
    const durationSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;

    // End time and duration each stand in for the other: a dropoff time yields
    // the duration, a duration yields the dropoff time. Where the export gives
    // NEITHER, the ride stays a point in time and both are left unset rather
    // than invented.
    //
    // When BOTH are present each is read from its own column rather than
    // derived. That is not fussiness: Uber rounds the two independently, and on
    // a real 81-row export 14 of the 79 completed rides had
    // trip_duration_seconds disagreeing with (dropoff - begintrip) by ±1s.
    // Deriving either from the other would publish a value the export contradicts.
    //
    // The fall-back arms are DEFENSIVE, not observed: in every real export
    // inspected, the only rows missing a dropoff time or a duration were the
    // cancelled ones, which are already skipped above. Likewise the
    // non-negative check below — a dropoff preceding its pickup has never been
    // seen in real data (0 of 89 rows); it guards against a value that would
    // otherwise reach CI-Server's duration_minutes as a negative integer.
    const end =
      dropoffTs ?? (durationSeconds != null ? new Date(ts.getTime() + durationSeconds * 1000) : undefined);
    const elapsedMs = dropoffTs ? dropoffTs.getTime() - ts.getTime() : undefined;
    const durationMinutes =
      durationSeconds != null
        ? Math.round(durationSeconds / 60)
        : elapsedMs != null && elapsedMs >= 0
          ? Math.round(elapsedMs / 60000)
          : undefined;

    const origin = pick(row, 'begintrip_address', 'Begin Trip Address');
    const dest = pick(row, 'dropoff_address', 'Dropoff Address');
    const summary = origin && dest ? `${origin} → ${dest}` : origin || dest || 'Uber trip';
    // The event's own title, phrased for a human timeline. Degrades cleanly when
    // the export recorded only one end of the route.
    const title =
      origin && dest
        ? `Uber ride from ${origin} to ${dest}`
        : origin
          ? `Uber ride from ${origin}`
          : dest
            ? `Uber ride to ${dest}`
            : 'Uber ride';

    const pickup = this.coordsOf(row, 'begintrip_lat', 'Begin Trip Lat', 'begintrip_lng', 'Begin Trip Lng');
    const dropoff = this.coordsOf(row, 'dropoff_lat', 'Dropoff Lat', 'dropoff_lng', 'Dropoff Lng');

    const city = pick(row, 'city_name', 'City');
    const product = pick(row, 'product_type_name', 'global_product_name', 'Product Type');
    const distance = pick(row, 'trip_distance_miles', 'Distance (miles)');
    const fare = pick(row, 'fare_amount', 'Fare Amount');
    const currency = pick(row, 'currency_code', 'Fare Currency');

    // Stable composite id (no single export id column); identical across re-runs.
    const key = ['uber', tsRaw, origin, dest, fare].join('|');

    params.pipeline.push({
      item: {
        id: key,
        classification: 'trip',
        timestamp: ts,
        ...(end ? { timespanEnd: end } : {}),
        // The event is anchored where the ride began, or — failing that — where
        // it was requested from, which is within a block of it.
        ...((pickup ?? request) ? { location: pickup ?? request } : {}),
        content: { filename: 'trip.txt', mediaType: 'text/plain', data: async () => Buffer.from(summary) },
        metadata: {
          Title: title,
          City: city || undefined,
          'Product Type': product || undefined,
          'Pickup Address': origin || undefined,
          'Dropoff Address': dest || undefined,
          'Distance (miles)': distance || undefined,
          'Duration (minutes)': durationMinutes,
          'Fare Amount': fare || undefined,
          'Fare Currency': currency || undefined,
          Status: status || undefined,
          Summary: summary,
          Source: 'Uber',
        },
      },
    });

    // Each recorded fix of the ride as its own position. The trip event carries
    // only the pickup, so without these the request and dropoff coordinates —
    // and their distinct times — would not reach the position table at all.
    this.pushTripPosition(`${key}|request`, 'Request', request, requestTs, '', title, params);
    this.pushTripPosition(`${key}|pickup`, 'Pickup', pickup, ts, origin, title, params);
    this.pushTripPosition(`${key}|dropoff`, 'Dropoff', dropoff, end, dest, title, params);
  }

  // Both coordinate pairs read the same way: (0,0) is Uber's placeholder for a
  // trip leg with no recorded GPS, so it is missing rather than a point at sea.
  private coordsOf(
    row: Record<string, string>,
    latKey: string,
    latLegacy: string,
    lonKey: string,
    lonLegacy: string,
  ): { latitude: number; longitude: number } | undefined {
    const lat = parseCoord(pick(row, latKey, latLegacy));
    const lon = parseCoord(pick(row, lonKey, lonLegacy));
    if (lat === undefined || lon === undefined) {
      return undefined;
    }

    if (lat === 0 && lon === 0) {
      return undefined;
    }

    return { latitude: lat, longitude: lon };
  }

  // One 'location' item per recorded fix. 'location' is what the CI-Server
  // mapping resolves to location.fix, which routes to the position table only —
  // so these never double the ride on the events timeline.
  private pushTripPosition(
    id: string,
    leg: 'Request' | 'Pickup' | 'Dropoff',
    coords: { latitude: number; longitude: number } | undefined,
    ts: Date | undefined,
    address: string,
    tripTitle: string,
    params: ImportParams,
  ): void {
    // A leg needs both a fix and its own time; the dropoff half of a legacy
    // export routinely has neither, and the request half of an older row has no
    // coordinates even though its timestamp is always populated.
    if (!coords || !ts) {
      return;
    }

    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    // The body is a human sentence either way — it is read by a person, not by
    // the place-name mapping.
    const body = address || `${tripTitle} (${leg.toLowerCase()})`;
    params.pipeline.push({
      item: {
        id,
        classification: 'location',
        timestamp: ts,
        location: coords,
        content: { filename: 'position.txt', mediaType: 'text/plain', data: async () => Buffer.from(body) },
        metadata: {
          // `Title` and `Name` are both read as the fix's PLACE NAME
          // (push/inputs.ts toPositionInput, via titleFor's location.fix arm), so
          // each is set only when the export actually recorded an address for
          // THIS leg. The ride narration used to fill the gap, and a trip
          // narration names the TRIP, not any point along it — the same defect
          // as gpx stamping a track name on every trackpoint. 37 positions on
          // the corpus were named "Uber ride from <addr> to <addr> (request)",
          // and `promote.place_position` turned 7 of them into Location entities
          // that the Places list rendered as venues.
          //
          // The narration is not lost: it stays on `Trip` (with `Leg`), which is
          // provenance, and the request leg's fix keeps its coordinates and a
          // NULL name — which is exactly what makes it a reverse-geocode
          // candidate, so it ends up better named than the narration ever was.
          Title: address || undefined,
          Name: address || undefined,
          Leg: leg,
          Trip: tripTitle,
          Source: 'Uber',
        },
      },
    });
  }

  private async processEatsFile(fpath: string, params: ImportParams): Promise<void> {
    const base = path.basename(fpath);
    let raw: string;
    try {
      raw = await fs.promises.readFile(fpath, 'utf8');
    } catch (e) {
      params.log?.('error', `Failed to read ${base}`, { error: (e as Error).message });

      return;
    }

    let rows: Record<string, string>[];
    try {
      rows = parseCSV(raw);
    } catch (e) {
      params.log?.('error', `Failed to parse ${base}`, { error: (e as Error).message });

      return;
    }

    // One CSV row = one line item; group line items into orders by (time, restaurant).
    // The export has no order id, so (request time + restaurant) is the natural key.
    const orders = new Map<string, Record<string, string>[]>();
    for (const row of rows) {
      const key = `${row['Request_Time_Local'] || ''}|${row['Restaurant_Name'] || ''}`;
      const list = orders.get(key);
      if (list) {
        list.push(row);
      } else {
        orders.set(key, [row]);
      }
    }

    if (!orders.size) {
      params.log?.('warn', `Uber Eats: ${base} parsed 0 orders`);
    }

    for (const items of orders.values()) {
      try {
        this.pushEatsOrder(items, params);
      } catch (e) {
        params.log?.('error', `Failed to import Eats order in ${base}`, { error: (e as Error).message });
      }
    }
  }

  private pushEatsOrder(items: Record<string, string>[], params: ImportParams): void {
    const first = items[0];
    const status = first['Order_Status'] || '';
    // An order that was cancelled is not a meal: nothing was delivered, eaten or
    // (usually) paid for. Skipping it here also keeps its line items from
    // reaching the food entities — a dish you cancelled is not a dish you have
    // had, and its price is not a price you have paid. Matched on the stem, the
    // same way a cancelled ride is (Uber spells it canceled/CANCELED/
    // customer_canceled), and reported rather than silently dropped.
    if (/cancel/i.test(status)) {
      params.pipeline.drop?.('cancelled_order', status);

      return;
    }

    const tsRaw = first['Request_Time_Local'] || '';
    const ts = parseUberDate(tsRaw);
    if (!timeframeContains(params.timeframe, ts)) {
      return;
    }

    const restaurant = first['Restaurant_Name'] || 'Uber Eats order';
    const city = first['City_Name'] || '';
    const orderPrice = first['Order_Price'] || '';
    const currency = first['Currency'] || '';
    const itemNames = items
      .map((it) => {
        const name = it['Item_Name'] || '';
        const qty = parseInt(it['Item_quantity'] || '1', 10);

        return name ? (qty > 1 ? `${qty}× ${name}` : name) : '';
      })
      .filter(Boolean);
    // The order's itemisation, in the shape the receipt mapper reads
    // (push/inputs.ts toReceiptLineItemInputs). An Eats order row IS a line
    // item — the CSV has one row per dish — so the grouping this method already
    // does by (request time, restaurant) is exactly the receipt. A
    // commerce.transaction carrying LineItems routes to `receipts` as well as
    // to `events`, so the meal keeps its timeline entry AND becomes a receipt
    // with the dishes on it.
    //
    // LINE NUMBER STABILITY: `items` is the CSV's own row order within the
    // group, so a re-import of the same export renumbers nothing.
    const lineItems: LineItemRecord[] = items
      .filter((it) => (it['Item_Name'] || '').trim())
      .map((it, i) => ({
        LineNumber: i + 1,
        Product: (it['Item_Name'] || '').trim(),
        Quantity: parseInt(it['Item_quantity'] || '1', 10) || 1,
        // Eats prices the LINE, not the unit; `Item_Price` is what the line
        // cost, so it is the TOTAL, not a unit price.
        Total: it['Item_Price'] ? parsePrice(it['Item_Price']) : undefined,
        Currency: currency || undefined,
        // A dish is a PHYSICAL good, and stating it (rather than letting the
        // name heuristic guess) is what stops "Kindle Bowl" or "Gift Card Roll"
        // being read as a digital purchase. `IsDigital: false` means
        // is_physical: TRUE on the receipt line.
        //
        // It does not put the dish in ci.objects: an Eats order is a
        // commerce.transaction carrying LineItems, which routes to events +
        // receipts. Line items live on the receipt; only a commerce.purchase
        // record mints an object row. "Not a thing you keep" is a
        // distinction the schema does not draw, and faking it with is_physical
        // would mislabel every meal as a digital good.
        IsDigital: false,
        Customizations: (it['Customizations'] || '').trim() || undefined,
      }));
    const summary = itemNames.length ? `${restaurant} — ${itemNames.join(', ')}` : restaurant;

    params.pipeline.push({
      // ISO where the export's timestamp parsed, the raw cell where it didn't —
      // the entry records WHEN, and an unparseable cell is still a better answer
      // than no answer.
      edges: this.foodEdges(items, ts ? ts.toISOString() : tsRaw),
      item: {
        // Stable per-order id (no order id in the export): request time + restaurant.
        id: ['ubereats', tsRaw, restaurant].join('|'),
        classification: 'transaction', // commerce.transaction -> events (food delivery is spend, not a thing you keep)
        timestamp: ts,
        content: { filename: 'order.txt', mediaType: 'text/plain', data: async () => Buffer.from(summary) },
        metadata: {
          // The event's own title, phrased for a human timeline — what you did,
          // not just where from.
          Title: `Ordered food from ${restaurant} via Uber Eats`,
          Restaurant: restaurant,
          City: city || undefined,
          'Order Status': status || undefined,
          // Kept under its export name AND under the canonical `Total`
          // (push/commerceKeys.ts) so the receipt header gets an order total
          // without the reader needing an Uber-specific chain entry.
          'Order Price': orderPrice || undefined,
          Total: orderPrice ? parsePrice(orderPrice) : undefined,
          Currency: currency || undefined,
          Items: itemNames.length ? itemNames : undefined,
          LineItems: lineItems.length ? lineItems : undefined,
          // CANONICAL merchant key: the restaurant is who was paid.
          Merchant: restaurant,
          // CANONICAL place key (push/canonical.ts locationNameFor). A
          // restaurant is a real place, and it is the one commerce source that
          // reliably names one — Amazon and card exports name a seller, not a
          // location. This is what populates ci.receipts.place_entity_id, which
          // in turn is what ObjectResolutionService's place_prior rung reads.
          //
          // Node volume is bounded and correct: the place is resolved under the
          // natural key `place:<lowercased name>`, so every order from the same
          // restaurant converges on ONE node rather than minting one per order.
          // The city qualifies the name where the export gives it, so two
          // same-named branches in different cities stay distinct.
          Place: city ? `${restaurant}, ${city}` : restaurant,
          'Item Count': items.length,
          Summary: summary,
          Source: 'Uber Eats',
        },
      },
    });
  }

  // One entity per line item of an order, hung off the order by an `includes`
  // edge (the same relation Google Photos uses for the people in a photo).
  //
  // Type is 'food' for EVERY line item, drinks included: telling a latte from a
  // sandwich would need a classifier the importer has no business owning, and a
  // wrong guess is worse than a coarse-but-honest label.
  //
  // Entities upsert on (type, name) in persistence, so a dish ordered on five
  // different nights resolves to ONE row that five orders point at — which is
  // the point of making it an entity rather than a metadata string.
  //
  // One ORDER of the dish therefore ACCUMULATES (Entity.accumulate) as a
  // { date, restaurant, price } entry rather than the dish being frozen at its
  // first sighting. The three travel together because they are only meaningful
  // together: a burger at $6.79 and a burger at $17.89 is not a contradiction
  // once you can see that one was McDonald's in February and the other Yard
  // House in March. Kept as separate lists, that link is unrecoverable — the
  // nth price and the nth restaurant have no way to find each other.
  private foodEdges(items: Record<string, string>[], orderedAt: string): Relationship[] {
    const edges: Relationship[] = [];
    for (const it of items) {
      const name = (it['Item_Name'] || '').trim();
      if (!name) {
        continue;
      }

      edges.push({
        relation: 'includes',
        to: {
          entity: {
            type: 'food',
            name,
            accumulate: ['Orders', 'Customizations'],
            metadata: {
              // A single-element list because that is the shape it keeps: the
              // next order of this dish appends its own entry.
              //
              // `price` is the LINE ITEM's price. Order_Price is the whole
              // basket — it belongs to the transaction, not to any one dish, so
              // it is deliberately never copied here.
              Orders: [
                {
                  ...(orderedAt ? { date: orderedAt } : {}),
                  ...(it['Restaurant_Name'] ? { restaurant: it['Restaurant_Name'] } : {}),
                  ...(it['Item_Price'] ? { price: parsePrice(it['Item_Price']) } : {}),
                },
              ],
              // Customizations ride the dish rather than becoming entities of
              // their own: "no onions" is a property of this burger, not a
              // thing in the world worth a row and a graph node.
              Customizations: it['Customizations'] ? [it['Customizations']] : undefined,
              // Not accumulated: the first sighting's value stands. A delivery
              // note ("ring the doorbell") describes the order, not the dish,
              // and a per-order cost is already implied by the order entries.
              'Customization Cost': it['Customization_Cost_Local'] || undefined,
              'Special Instructions': it['Special_Instructions'] || undefined,
              Currency: it['Currency'] || undefined,
              Source: 'Uber Eats',
            },
          },
        },
      });
    }

    return edges;
  }
}

registerDataSource({
  name: 'uber',
  title: 'Uber',
  icon: '',
  description: 'Trips and Uber Eats orders from an Uber privacy export (trips_data*.csv + user_orders*.csv).',
  newFileImporter: () => new UberFileImporter(),
});
