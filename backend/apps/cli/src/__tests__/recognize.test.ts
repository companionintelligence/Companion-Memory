import { recognizeCommand } from '../commands/recognize';
import { CliError } from '../context';

import { harness } from './support/harness';

describe('ci recognize', () => {
  it('tables the matches, best first', async () => {
    const ctx = harness({
      recognize: async () => ({
        allowed: true,
        path: '/srv/exports/Takeout',
        recognized: [
          {
            dataSource: 'google_photos',
            title: 'Google Photos',
            confidence: 0.9,
            matchedPath: '/srv/exports/Takeout/Photos',
          },
          { dataSource: 'gmail', title: 'Gmail', confidence: 0.6, matchedPath: '/srv/exports/Takeout/Mail' },
        ],
      }),
    });

    await recognizeCommand(ctx, '/srv/exports/Takeout');

    const text = ctx.term.text();

    expect(text.indexOf('google_photos')).toBeLessThan(text.indexOf('gmail'));
    expect(text).toContain('0.90');
    expect(text).toContain('2 match(es)');
  });

  it('shows matches relative to the queried root, not as one long repeated prefix', async () => {
    const ctx = harness({
      recognize: async () => ({
        allowed: true,
        path: '/srv/exports/Takeout',
        recognized: [
          {
            dataSource: 'google_photos',
            title: 'Google Photos',
            confidence: 0.9,
            matchedPath: '/srv/exports/Takeout/Google Photos',
          },
          {
            dataSource: 'generic',
            title: 'Generic',
            confidence: 1,
            matchedPath: '/srv/exports/Takeout',
          },
        ],
      }),
    });

    await recognizeCommand(ctx, '/srv/exports/Takeout');

    const text = ctx.term.text();

    expect(text).toContain('Google Photos');
    // The root itself, and no repeated absolute prefix in the table body.
    expect(text).toMatch(/generic\s+1\.00\s+Generic\s+\./);
  });

  it('sends an absolute path even when given a relative one', async () => {
    const seen: string[] = [];
    const ctx = harness({
      recognize: async (path: string) => {
        seen.push(path);

        return { allowed: true, path, recognized: [] };
      },
    });

    await recognizeCommand(ctx, './somewhere');

    expect(seen[0].startsWith('/')).toBe(true);
  });

  it('turns an out-of-roots refusal into the two ways forward', async () => {
    const ctx = harness({
      recognize: async () => ({
        allowed: false,
        reason: '/etc is outside the configured import roots (/srv/exports).',
        recognized: [],
      }),
    });

    await expect(recognizeCommand(ctx, '/etc')).rejects.toBeInstanceOf(CliError);

    try {
      await recognizeCommand(ctx, '/etc');
    } catch (err) {
      expect((err as CliError).message).toContain('outside the configured import roots');
      expect((err as CliError).message).toContain('ci inbox');
      // The upload route needs no root at all, which is the answer most people want.
      expect((err as CliError).message).toContain('ci import');
    }
  });

  it('says nothing matched without pretending that is fatal', async () => {
    const ctx = harness({
      recognize: async () => ({ allowed: true, path: '/srv/exports/mystery', recognized: [] }),
    });

    await recognizeCommand(ctx, '/srv/exports/mystery');

    expect(ctx.term.text()).toContain('No importer recognizes /srv/exports/mystery');
    expect(ctx.term.text()).toContain('not always a dead end');
  });

  it('still exits non-zero on a refusal under --json, after printing the payload', async () => {
    const ctx = harness({
      recognize: async () => ({ allowed: false, reason: 'nope', recognized: [] }),
    });

    await expect(recognizeCommand(ctx, '/etc', { json: true })).rejects.toBeInstanceOf(CliError);
    expect(JSON.parse(ctx.term.text())).toMatchObject({ allowed: false });
  });
});
