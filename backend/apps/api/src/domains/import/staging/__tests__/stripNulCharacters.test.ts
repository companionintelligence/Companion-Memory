import type { Graph } from '../../datasources/timeline';
import { stripNulCharacters } from '../stripNulCharacters';

describe('stripNulCharacters', () => {
  it('removes U+0000 from strings at any depth, in value and key position', () => {
    const graph: Graph = {
      item: {
        classification: 'com.discord.message',
        originalLocation: 'Messages/c922\u0000/messages.json',
        metadata: {
          text: 'Vertex shader is not compiled.\n\u0000\nVERTEX',
          ['bad\u0000key']: 'kept\u0000value',
          tags: ['a\u0000', 'b'],
          nested: [{ note: 'x\u0000y' }],
        },
      },
      entity: {
        name: 'some\u0000one',
        attributes: [{ name: 'email', value: 'a\u0000b@example.invalid', identity: true }],
      },
      edges: [
        { relation: 'from\u0000', to: { entity: { name: 'peer\u0000' } }, metadata: { via: '\u0000dm' } },
      ],
    };

    stripNulCharacters(graph);

    expect(graph.item?.originalLocation).toBe('Messages/c922/messages.json');
    expect(graph.item?.metadata).toEqual({
      text: 'Vertex shader is not compiled.\n\nVERTEX',
      badkey: 'keptvalue',
      tags: ['a', 'b'],
      nested: [{ note: 'xy' }],
    });
    expect(graph.entity?.name).toBe('someone');
    expect(graph.entity?.attributes?.[0].value).toBe('ab@example.invalid');
    expect(graph.edges?.[0].relation).toBe('from');
    expect(graph.edges?.[0].to.entity?.name).toBe('peer');
    expect(graph.edges?.[0].metadata).toEqual({ via: 'dm' });
  });

  it('leaves other control characters, Dates and the lazy content loader alone', () => {
    const timestamp = new Date('2021-12-21T00:00:00Z');
    const data = async () => Buffer.from('bytes');
    const graph: Graph = {
      item: {
        timestamp,
        content: { filename: 'log\u0000.txt', data },
        metadata: { text: 'tab\tand\nnewline stay' },
      },
    };

    stripNulCharacters(graph);

    expect(graph.item?.timestamp).toBe(timestamp);
    expect(graph.item?.content?.data).toBe(data);
    expect(graph.item?.content?.filename).toBe('log.txt');
    expect(graph.item?.metadata?.text).toBe('tab\tand\nnewline stay');
  });

  it('survives a cyclic graph', () => {
    const graph: Graph = { item: { metadata: { text: 'a\u0000b' } } };

    (graph.item!.metadata as Record<string, unknown>).self = graph.item!.metadata;

    stripNulCharacters(graph);

    expect(graph.item?.metadata?.text).toBe('ab');
  });
});
