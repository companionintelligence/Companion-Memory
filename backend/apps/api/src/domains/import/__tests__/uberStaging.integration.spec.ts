import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Graph, ImportParams } from '../datasources/timeline';
import { UberFileImporter } from '../datasources/uber';

import { createStagingHarness, importDatabase, type StagingHarness } from './support/stagingHarness';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE `accumulate[]` CONTRACT, AGAINST REAL POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An entity upserts on identity, so the second time a source describes the same
 * thing the existing row normally wins. That is right for a display name and
 * wrong for a fact that legitimately differs per sighting — which is what these
 * two cases are about. A dish costing $4.50 in December and $4.75 the next
 * morning is two true facts, and the useful record is the set of them, not
 * whichever arrived first.
 *
 * The parsers declare which keys behave that way (`Entity.accumulate`), and
 * `mergeAccumulatedMetadata` implements it. Only a real database shows the
 * upsert-then-grow path: the first sighting INSERTs, the second hits
 * `staged_entities_run_identity_uniq`, reads the stored bag back and grows it.
 *
 * The rest of the upstream Uber suite is parser-level and needs no database —
 * it lives in `datasources/__tests__/uber.test.ts`.
 */

const describeWithDatabase = importDatabase.available ? describe : describe.skip;

if (!importDatabase.available) {
  console.warn(`[import/uberStaging.integration] SKIPPED — ${importDatabase.reason}`);
}

jest.setTimeout(60_000);

const EATS_HEADER =
  'City_Name,Restaurant_Name,Request_Time_Local,Final_Delivery_Time_Local,Order_Status,' +
  'Item_Name,Item_quantity,Customizations,Customization_Cost_Local,Special_Instructions,' +
  'Item_Price,Order_Price,Currency';

/** Build a nested export directory and import from its root, as a real drop would. */
async function importEats(rows: string[]): Promise<{ graphs: Graph[]; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-uber-eats-'));
  const file = path.join(root, 'Uber Data', 'Eats', 'user_orders-0.csv');

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [EATS_HEADER, ...rows].join('\n'));

  const graphs: Graph[] = [];

  await new UberFileImporter().fileImport({}, { filename: path.basename(root), fullPath: root }, {
    pipeline: { push: (graph: Graph) => graphs.push(graph) },
    timeframe: {},
    log: () => {},
  } as unknown as ImportParams);

  return { graphs, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

describeWithDatabase(`uber eats staging (${importDatabase.target})`, () => {
  let harness: StagingHarness;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ harness, teardown } = await createStagingHarness());
  });

  afterAll(async () => {
    await teardown();
  });

  it('stages one row per dish across orders, each linked to the order that ordered it', async () => {
    // The same croissant on two mornings is ONE entity with TWO edges, not two
    // entities — that is the upsert in play.
    const { graphs, cleanup } = await importEats([
      'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Croissant,1,"Warmed",0.00,"",4.50,9.00,USD',
      'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Iced Latte,1,"",,"",4.50,9.00,USD',
      'SF,Chouquets,2022-12-17T14:00:00.000Z,2022-12-17T14:30:00.000Z,completed,Croissant,1,"",,"",4.75,4.75,USD',
    ]);

    try {
      const { writer, runId } = await harness.writerFor('uber');

      for (const graph of graphs) {
        writer.push(graph);
      }

      await writer.settled();

      const rows = await harness.dataSource.query<
        Array<{ name: string; metadata: Record<string, unknown>; accumulate: string[] | null }>
      >(
        `SELECT name, metadata, accumulate FROM ci_import.staged_entities
          WHERE run_id = $1::uuid AND type = 'food' ORDER BY name`,
        [runId],
      );

      expect(rows.map((row) => row.name)).toEqual(['Croissant', 'Iced Latte']);

      // Both mornings on the one row: the second order GREW it rather than
      // being dropped as a duplicate of the first.
      expect(rows[0].metadata).toMatchObject({
        Customizations: ['Warmed'],
        Orders: [
          { date: '2022-12-16T14:41:18.000Z', restaurant: 'Chouquets', price: 4.5 },
          { date: '2022-12-17T14:00:00.000Z', restaurant: 'Chouquets', price: 4.75 },
        ],
      });

      // A dish is not a contact, so staging keeps exactly what the parser
      // declared and the push unions just those keys into the graph row.
      expect(rows[0].accumulate).toEqual(['Orders', 'Customizations']);

      const [{ orders }] = await harness.dataSource.query<Array<{ orders: string }>>(
        `SELECT COUNT(DISTINCT r.item_id) AS orders
           FROM ci_import.staged_relationships r
           JOIN ci_import.staged_entities e ON e.id = r.entity_id
          WHERE r.run_id = $1::uuid AND e.name = 'Croissant' AND r.relation = 'includes'`,
        [runId],
      );

      // Both orders point at the one Croissant row.
      expect(orders).toBe('2');
    } finally {
      cleanup();
    }
  });

  it('keeps each order date, restaurant and price tied to each other', async () => {
    // A dish name is not namespaced by restaurant, so one Hamburger entity
    // covers all three — and $3.79 against $16.50 only means anything once each
    // price is tied to the place and the night it was paid. Three parallel
    // lists could not express that; one list of triples can.
    const { graphs, cleanup } = await importEats([
      `LA,McDonald's,2024-02-01T18:00:00.000Z,2024-02-01T18:25:00.000Z,completed,Hamburger,1,"",,"",3.79,3.79,USD`,
      'LA,Yard House,2024-03-02T19:00:00.000Z,2024-03-02T19:40:00.000Z,completed,Hamburger,1,"",,"",16.50,16.50,USD',
      'LA,In-N-Out,2024-04-03T12:00:00.000Z,2024-04-03T12:20:00.000Z,completed,Hamburger,1,"",,"",4.25,4.25,USD',
    ]);

    try {
      const { writer, runId } = await harness.writerFor('uber');

      for (const graph of graphs) {
        writer.push(graph);
      }

      await writer.settled();

      const rows = await harness.dataSource.query<Array<{ metadata: Record<string, unknown> }>>(
        `SELECT metadata FROM ci_import.staged_entities
          WHERE run_id = $1::uuid AND name = 'Hamburger'`,
        [runId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.Orders).toEqual([
        { date: '2024-02-01T18:00:00.000Z', restaurant: "McDonald's", price: 3.79 },
        { date: '2024-03-02T19:00:00.000Z', restaurant: 'Yard House', price: 16.5 },
        { date: '2024-04-03T12:00:00.000Z', restaurant: 'In-N-Out', price: 4.25 },
      ]);

      // The parallel lists these triples replaced are gone, not merely unused.
      expect(rows[0].metadata['Item Prices']).toBeUndefined();
      expect(rows[0].metadata.Restaurants).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it('marks a grown entity dirty so the push revisits it', async () => {
    const { graphs, cleanup } = await importEats([
      'SF,Chouquets,2022-12-16T14:41:18.000Z,2022-12-16T15:10:00.000Z,completed,Croissant,1,"",,"",4.50,4.50,USD',
      'SF,Chouquets,2022-12-17T14:00:00.000Z,2022-12-17T14:30:00.000Z,completed,Croissant,1,"",,"",4.75,4.75,USD',
    ]);

    try {
      const { writer, runId } = await harness.writerFor('uber');

      for (const graph of graphs) {
        writer.push(graph);
      }

      await writer.settled();

      const [row] = await harness.dataSource.query<Array<{ graph_dirty: boolean }>>(
        `SELECT graph_dirty FROM ci_import.staged_entities
          WHERE run_id = $1::uuid AND name = 'Croissant'`,
        [runId],
      );

      // The push resumes from a high-water mark, so a row that grew after it was
      // already sent would never be revisited without this flag.
      expect(row.graph_dirty).toBe(true);
      expect(writer.totals.entitiesGrown).toBeGreaterThan(0);
    } finally {
      cleanup();
    }
  });
});
