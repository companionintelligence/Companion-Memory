/*
 * One service's export must not be claimed by another service's importer.
 *
 * The parse stage runs EVERY importer that recognizes something in an upload,
 * so a recognizer that accepts another service's file reads it in full and the
 * same records land twice, or under a service the person never used. These
 * cases run recognition over the whole registry, as the parse stage does, on
 * exports shaped like the real ones.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DataSourceRecognition, DirEntry } from '../registry';
import { dataSourcesRecognize } from '../registry';
import type { Graph, ImportParams } from '../timeline';
import '../index';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

async function recognizeTree(root: string): Promise<DataSourceRecognition[]> {
  const entry: DirEntry = { filename: path.basename(root), fullPath: root, fsRoot: root };

  return dataSourcesRecognize(undefined, entry, {}, { descend: true });
}

const names = (matches: DataSourceRecognition[]) =>
  [...new Set(matches.map((m) => m.data_source.name))].sort();

describe('importers do not claim other services’ exports', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-cross-claims-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(rel: string, body: string): void {
    const fpath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(fpath), { recursive: true });
    fs.writeFileSync(fpath, body);
  }

  it('a Strava export is read by strava alone, not also by garmin', async () => {
    write(
      'export_88123456/activities.csv',
      'Activity ID,Activity Date,Activity Name,Activity Type,Activity Description,Elapsed Time,' +
        'Distance,Max Heart Rate,Relative Effort,Commute,Activity Private Note,Activity Gear,' +
        'Filename,Athlete Weight,Bike Weight,Elapsed Time,Moving Time,Distance,Max Speed,' +
        'Average Speed,Elevation Gain,Elevation Loss,Max Heart Rate,Average Heart Rate,Calories,Media\n' +
        '16012345101,"Mar 14, 2026, 7:05:12 AM",Creek tempo run,Run,,1980,6.12,176,48,false,,,' +
        'activities/16012345101.gpx,71.5,,1980.0,1841.0,6120.0,6.1,3.091,88.0,84.0,176,151.2,512.0,\n',
    );
    write(
      'export_88123456/activities/16012345101.gpx',
      '<?xml version="1.0"?><gpx version="1.1" creator="StravaGPX"><trk><trkseg>' +
        '<trkpt lat="47.6" lon="-122.3"><time>2026-03-14T07:05:12Z</time></trkpt></trkseg></trk></gpx>',
    );

    const found = names(await recognizeTree(dir));
    expect(found).toContain('strava');
    expect(found).not.toContain('garmin');
  });

  it('a MyFitnessPal export is read by myfitnesspal alone, not also by withings', async () => {
    const range = '2026-10-12-to-2026-10-14';
    write(
      `File-Export-${range}/Nutrition-Summary-${range}.csv`,
      'Date,Meal,Calories,Fat (g),Carbohydrates (g),Protein (g),Note\n2026-10-12,Breakfast,412.5,13.1,51.2,21.4,\n',
    );
    write(`File-Export-${range}/Measurement-Summary-${range}.csv`, 'Date,Weight\n2026-10-12,71.4\n');
    write(
      `File-Export-${range}/Exercise-Summary-${range}.csv`,
      'Date,Exercise,Type,Exercise Calories,Exercise Minutes,Sets,Reps Per Set,Kilograms,Steps,Note\n' +
        '2026-10-13,Bench Press,Strength,,,4,8,60,,\n',
    );

    const found = names(await recognizeTree(dir));
    expect(found).toContain('myfitnesspal');
    expect(found).not.toContain('withings');
  });

  it('an Instagram export is read by instagram alone, not also by facebook', async () => {
    for (const fixture of ['instagram-export', 'instagram-html-export']) {
      const found = names(await recognizeTree(path.join(FIXTURES_DIR, fixture)));
      expect({
        fixture,
        instagram: found.includes('instagram'),
        facebook: found.includes('facebook'),
      }).toEqual({
        fixture,
        instagram: true,
        facebook: false,
      });
    }
  });

  it("an X archive's Grok chats come in once, from grok, beside the tweets", async () => {
    const rows = [
      {
        chatId: 'chat1',
        createdAt: '2026-01-10T07:48:58.157Z',
        sender: { name: 'User' },
        message: 'Ferry time at 14 knots?',
      },
      {
        chatId: 'chat1',
        createdAt: '2026-01-10T07:48:58.157Z',
        sender: { name: 'Agent' },
        message: 'About 25 minutes.',
      },
    ];
    write(
      'twitter-2026/data/manifest.js',
      `window.YTD.manifest.part0 = ${JSON.stringify({ archiveInfo: { generationDate: '2026-06-20T05:13:48.343Z' } })}`,
    );
    write(
      'twitter-2026/data/account.js',
      `window.YTD.account.part0 = ${JSON.stringify([{ account: { accountId: '1', username: 'tester' } }])}`,
    );
    write(
      'twitter-2026/data/tweets.js',
      `window.YTD.tweets.part0 = ${JSON.stringify([
        {
          tweet: {
            id: '9',
            id_str: '9',
            created_at: 'Sun Jan 05 18:15:00 +0000 2025',
            full_text: 'a tweet',
            favorite_count: '0',
            retweet_count: '0',
            entities: { urls: [], user_mentions: [] },
          },
        },
      ])}`,
    );
    write(
      'twitter-2026/data/grok-chat-item.js',
      `window.YTD.grok_chat_item.part0 = ${JSON.stringify(rows.map((grokChatItem) => ({ grokChatItem })))}`,
    );

    const matches = (await recognizeTree(dir)).filter((m) => m.data_source.name !== 'generic');
    expect(names(matches)).toEqual(['grok', 'twitter']);

    // Run every match the way the parse stage does and count what each emits.
    const ids: string[] = [];
    for (const match of matches) {
      const matchedPath = match.matchedPath ?? dir;
      await match.data_source.newFileImporter!().fileImport(
        undefined,
        { filename: path.basename(matchedPath), fullPath: matchedPath, fsRoot: dir },
        {
          timeframe: {},
          log: () => {},
          options: {},
          pipeline: { push: (g: Graph) => ids.push(g.item!.id!), drop: () => {} },
        } as unknown as ImportParams,
      );
    }

    const grokIds = ids.filter((id) => id.startsWith('grok:'));
    expect(grokIds).toHaveLength(rows.length);
    expect(new Set(grokIds).size).toBe(rows.length);
    expect(ids.some((id) => id.startsWith('twitter:'))).toBe(true);
  });
});
