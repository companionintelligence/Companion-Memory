import { dataSourcesCommand } from '../commands/datasources';

import { harness } from './support/harness';

const gpx = {
  name: 'gpx',
  title: 'GPX tracks',
  description: '',
  icon: 'gpx.svg',
  stub: false,
  supportsFiles: true,
  supportsApi: false,
  guide: null,
};

const strava = { ...gpx, name: 'strava', title: 'Strava', supportsApi: true, stub: true };

describe('ci datasources', () => {
  it('tables the registered importers and counts the stubs', async () => {
    const ctx = harness({ listSources: async () => [gpx, strava] });

    await dataSourcesCommand(ctx);

    expect(ctx.term.text()).toContain('gpx');
    expect(ctx.term.text()).toContain('strava');
    expect(ctx.term.text()).toContain('2 importer(s), 1 recognized but not yet implemented (stub).');
  });

  it('emits the raw payload with --json', async () => {
    const ctx = harness({ listSources: async () => [gpx] });

    await dataSourcesCommand(ctx, { json: true });

    expect(JSON.parse(ctx.term.text())).toEqual([gpx]);
  });

  it('lists authored services with --catalog, preserving the curated order', async () => {
    const entries = [
      { id: 'google_photos', title: 'Google Photos', importer: 'google_photos', importerReady: true },
      { id: 'instagram', title: 'Instagram', importer: 'instagram', importerReady: false },
    ].map((entry) => ({
      ...entry,
      blurb: '',
      ecosystem: 'google',
      category: 'media',
      acquisition: 'web-export',
      wait: '1h',
      steps: [],
    }));

    const ctx = harness({ sourceCatalog: async () => entries });

    await dataSourcesCommand(ctx, { catalog: true });

    const text = ctx.term.text();

    expect(text.indexOf('google_photos')).toBeLessThan(text.indexOf('instagram'));
    // A service whose parser is unwritten still appears — silence would read as
    // "unsupported" and end the conversation.
    expect(text).toContain('instagram');
    expect(text).toContain('2 authored source(s).');
  });
});
