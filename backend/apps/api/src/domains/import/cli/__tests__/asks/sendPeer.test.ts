import { asksSendPeerCommand } from '../../commands/asks/sendPeer';
import { GraphQLApiError } from '../../graphqlClient';
import { askFixture } from '../support/fixtures';
import { harness } from '../support/harness';

describe('ci-import asks send-peer', () => {
  it('sends a federated ask with the token from the flag', async () => {
    const seen: unknown[] = [];
    const ctx = harness(
      {},
      {
        sendPeerAsk: async (input) => {
          seen.push(input);

          return { success: true, status: 'pending', reason: null, ask: askFixture(), answer: null };
        },
      },
    );

    await asksSendPeerCommand(
      ctx,
      'alice@portal.example',
      'Are you free Friday?',
      {
        archetype: 'availability',
        peerAccessToken: 'tok_123',
        minMinutes: '30',
      },
      {},
    );

    expect(seen).toEqual([
      {
        handle: 'alice@portal.example',
        prompt: 'Are you free Friday?',
        archetype: 'availability',
        subject: undefined,
        dataClass: undefined,
        from: undefined,
        to: undefined,
        minMinutes: 30,
        purpose: undefined,
        peerAccessToken: 'tok_123',
      },
    ]);
    expect(ctx.term.text()).toContain('pending');
  });

  it('falls back to CI_PEER_ACCESS_TOKEN when --peer-access-token is not passed', async () => {
    const seen: string[] = [];
    const ctx = harness(
      {},
      {
        sendPeerAsk: async (input) => {
          seen.push(input.peerAccessToken);

          return { success: true, status: 'pending', reason: null, ask: null, answer: null };
        },
      },
    );

    await asksSendPeerCommand(
      ctx,
      'alice@portal.example',
      'hi',
      { archetype: 'content' },
      {
        CI_PEER_ACCESS_TOKEN: 'from-env',
      },
    );

    expect(seen).toEqual(['from-env']);
  });

  it('requires --archetype before making a call', async () => {
    const ctx = harness({}, {});

    await expect(
      asksSendPeerCommand(ctx, 'alice@portal.example', 'hi', { peerAccessToken: 'tok' }, {}),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('--archetype is required') });
  });

  it('requires a token from somewhere before making a call', async () => {
    const ctx = harness({}, {});

    await expect(
      asksSendPeerCommand(ctx, 'alice@portal.example', 'hi', { archetype: 'content' }, {}),
    ).rejects.toMatchObject({ exitCode: 2, message: expect.stringContaining('CI_PEER_ACCESS_TOKEN') });
  });

  it('surfaces the server’s own refusal rather than a generic failure', async () => {
    const ctx = harness(
      {},
      {
        sendPeerAsk: async () => {
          throw new GraphQLApiError(
            'BAD_USER_INPUT',
            'archetype must be one of: relationship, content, availability',
            'sendPeerAsk',
          );
        },
      },
    );

    await expect(
      asksSendPeerCommand(
        ctx,
        'alice@portal.example',
        'hi',
        { archetype: 'identity', peerAccessToken: 'tok' },
        {},
      ),
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('archetype must be one of') });
  });

  it('does not swallow an auth failure', async () => {
    const ctx = harness(
      {},
      {
        sendPeerAsk: async () => {
          throw new GraphQLApiError('UNAUTHENTICATED', 'bad key', 'sendPeerAsk');
        },
      },
    );

    await expect(
      asksSendPeerCommand(
        ctx,
        'alice@portal.example',
        'hi',
        { archetype: 'content', peerAccessToken: 'tok' },
        {},
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
});
