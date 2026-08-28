import type { UnfurlService } from '@ci/domains/embed';

import { UnfurlStage } from '../enrich/UnfurlStage';

const USER = '019ee82a-2f70-71fd-b4a7-2679a8e5140b';
const ctx = { userId: USER };

function makeStage(rows: Array<Record<string, unknown>>, answers: Record<string, unknown>) {
  const dataSource = { query: jest.fn(async () => rows) };
  const resolveMany = jest.fn(async (_ctx: unknown, targets: Array<{ key: string }>) => {
    return new Map(targets.map((t) => [t.key, answers[t.key]]));
  });
  const stage = new UnfurlStage(
    dataSource as never,
    { resolveMany } as unknown as UnfurlService,
    { setContext: jest.fn(), warn: jest.fn(), log: jest.fn() } as never,
  );

  return { stage, resolveMany };
}

describe('UnfurlStage', () => {
  it('groups rows by resolve key so one request serves every play of a track', async () => {
    const rows = [
      {
        id: 'a',
        source_system: 'spotify',
        url: 'https://open.spotify.com/track/3fzTpBMSQKjo9sW0T8Tw2O',
        external_id: 'spotify:track:3fzTpBMSQKjo9sW0T8Tw2O',
        external_id_kind: 'external_uri',
      },
      {
        id: 'b',
        source_system: 'spotify',
        url: 'https://open.spotify.com/track/3fzTpBMSQKjo9sW0T8Tw2O?si=x',
        external_id: 'spotify:track:3fzTpBMSQKjo9sW0T8Tw2O',
        external_id_kind: 'external_uri',
      },
      { id: 'c', source_system: 'netflix', source_title: 'Dark: Season 1: Alpha and Omega (Episode 10)' },
    ];
    const { stage, resolveMany } = makeStage(rows, {
      'oembed:spotify:track:3fzTpBMSQKjo9sW0T8Tw2O': { kind: 'row', row: { status: 'ok' }, fresh: true },
      'wd:tv:dark': { kind: 'row', row: { status: 'not_found' }, fresh: true },
    });

    const results = await stage.run(ctx, ['a', 'b', 'c', 'gone']);

    expect(resolveMany).toHaveBeenCalledTimes(1);
    expect(resolveMany.mock.calls[0][1].map((t) => t.key).sort()).toEqual([
      'oembed:spotify:track:3fzTpBMSQKjo9sW0T8Tw2O',
      'wd:tv:dark',
    ]);
    expect(results.get('a')).toEqual({ outcome: 'done' });
    expect(results.get('b')).toEqual({ outcome: 'done' });
    expect(results.get('c')).toEqual({ outcome: 'skipped', reason: 'not_found' });
    expect(results.get('gone')).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('maps every service outcome onto the ledger vocabulary', async () => {
    const rows = [
      { id: 'u', url: 'https://soundcloud.com/artist/track' },
      { id: 'd', url: 'https://example.com/page' },
      { id: 't', url: 'https://vimeo.com/76979871' },
      { id: 'k', url: 'https://www.audible.com/pd/B005QDO084' },
      { id: 'n', source_system: 'audible' }, // nothing resolvable
      // Templated provider: poster and player come from the id, so no request —
      // and no OpenGraph fall-through either.
      { id: 'y', url: 'https://youtu.be/dQw4w9WgXcQ' },
    ];
    const { stage } = makeStage(rows, {
      'oembed:soundcloud:track:artist/track': { kind: 'unconfigured', detail: 'credential_missing' },
      'og:https://example.com/page': { kind: 'disabled', detail: 'open_graph_disabled' },
      'oembed:vimeo:video:76979871': { kind: 'row', row: { status: 'rate_limited' }, fresh: true },
      'og:https://audible.com/pd/B005QDO084': { kind: 'row', row: { status: 'blocked' }, fresh: false },
    });

    const results = await stage.run(ctx, ['u', 'd', 't', 'k', 'n', 'y']);

    expect(results.get('u')).toEqual({ outcome: 'skipped', reason: 'credential_missing' });
    expect(results.get('d')).toEqual({ outcome: 'skipped', reason: 'open_graph_disabled' });
    expect(results.get('t')).toEqual({ outcome: 'failed', reason: 'provider_unavailable' });
    expect(results.get('k')).toEqual({ outcome: 'skipped', reason: 'blocked' });
    expect(results.get('n')).toEqual({ outcome: 'skipped', reason: 'no_resolve_target' });
    expect(results.get('y')).toEqual({ outcome: 'skipped', reason: 'no_resolve_target' });
    // Every id answered — silence would be recorded as a failure by the worker.
    expect(results.size).toBe(6);
  });

  it('never mentions its own output table or the ledger in the applicability predicate', () => {
    const { stage } = makeStage([], {});
    expect(stage.source.predicate).not.toMatch(/unfurls|pipeline_state|\bp\./);
    expect(stage.source.predicate).toMatch(/^\(/);
  });
});
