import { generateKeyPairSync } from 'node:crypto';

import type { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';
import type { ConsumptionStore } from '@ci/domains/consumption';
import type { PeerAskService, PeerLinkService, PeerRateLimitService } from '@ci/domains/peers';
import { jwkThumbprint } from '@ci/domains/peers';

import { memoryClaimStore, newParty, signedRequest } from './__tests__/testKit';
import { ASK_REQUEST_TYPE_URI } from './askSpecs';
import { verifyEddsaJcs2022Proof } from './crypto/dataIntegrity';
import { TrustTasksService } from './TrustTasksService';
import { sovereignJwk } from './vid';

/** A usable private JWK, and the party whose key it is. */
function boxKey() {
  const pair = generateKeyPairSync('ed25519');
  const jwk = pair.privateKey.export({ format: 'jwk' });

  return { jwk, publicJwk: { kty: 'OKP', crv: 'Ed25519', x: jwk.x as string } };
}

interface Links {
  [vid: string]: { peerKeyJwk: unknown }[];
}

/** `null` means no key at all; omitting it generates a fresh, usable one. */
function build(links: Links = {}, signingKeyJwk: string | null = JSON.stringify(boxKey().jwk)) {
  config.peers.signingKeyJwk = signingKeyJwk ?? undefined;

  const handled: unknown[] = [];
  const lookups: string[] = [];
  const warnings: string[] = [];
  const logger = {
    setContext: () => undefined,
    warn: (message: string) => void warnings.push(message),
    log: () => undefined,
  } as unknown as LoggerService;
  const service = new TrustTasksService(
    memoryClaimStore() as unknown as ConsumptionStore,
    {
      handle: async (...args: unknown[]) => (
        handled.push(args),
        { askId: 'ask-2026-11-05-0001', status: 'pending', reason: 'No answer is available' }
      ),
      result: async () => ({ askId: 'ask-2026-11-05-0001', status: 'pending' }),
    } as unknown as PeerAskService,
    {
      findActiveByPeerIdentity: async (_issuer: string, vid: string) => (lookups.push(vid), links[vid] ?? []),
    } as unknown as PeerLinkService,
    { consume: async () => undefined, consumePoll: async () => undefined } as unknown as PeerRateLimitService,
    logger,
  );

  return { service, warnings, handled, lookups };
}

/** `admits` is private; it is the unit under test in the admission block, so it is reached directly. */
const admits = (service: TrustTasksService, vid: string): Promise<boolean> =>
  (service as unknown as { admits(vid: string): Promise<boolean> }).admits(vid);

/** Runs `body` with the `trust.tasks` feature set as given, and puts it back. */
async function withFeature(on: boolean, body: () => void | Promise<void>): Promise<void> {
  const before = config.features['trust.tasks'];
  config.features['trust.tasks'] = on;

  try {
    await body();
  } finally {
    config.features['trust.tasks'] = before;
  }
}

const ASK = {
  askId: 'ask-2026-11-05-0001',
  askerHandle: 'alice',
  prompt: 'Lunch Friday?',
  request: { archetype: 'availability', from: '2026-11-06T11:00:00Z', to: '2026-11-06T14:00:00Z' },
};

describe('TrustTasksService', () => {
  describe('the signing key', () => {
    const unusable = [null, '', 'not json', JSON.stringify({ kty: 'OKP', crv: 'Ed25519', x: 'AAAA' })];

    it('is closed — and says so in the log — when the operator turned the feature on and the box has no usable key', async () => {
      await withFeature(true, async () => {
        for (const missing of unusable) {
          const { service, warnings } = build({}, missing);

          expect(service.ready).toBe(false);
          expect(service.vid).toBeNull();
          expect(service.maxBodyBytes).toBe(0);
          expect(await service.handle({})).toEqual({ kind: 'refused' });
          expect(warnings.join('\n')).toContain('trust tasks closed');
        }
      });
    });

    it('is closed without a word in the log on a default install, where the feature is off', async () => {
      await withFeature(false, async () => {
        for (const missing of unusable) {
          const { service, warnings } = build({}, missing);

          expect(service.ready).toBe(false);
          expect(warnings).toEqual([]);
        }
      });
    });

    it('bounds the body by the largest document a served specification accepts', () => {
      const { service } = build();

      expect(service.maxBodyBytes).toBeGreaterThanOrEqual(16 * 1024);
    });

    it('derives the box’s VID from the key itself, not from a label on it', () => {
      const { jwk, publicJwk } = boxKey();
      const { service } = build({}, JSON.stringify({ ...jwk, kid: 'some-label' }));

      expect(service.ready).toBe(true);
      expect(service.vid).toBe(`did:keri:D${publicJwk.x}`);
    });
  });

  describe('admission', () => {
    const alice = newParty();
    const aliceKey = sovereignJwk(alice.vid) as Record<string, unknown>;
    // The service reads the real clock, so these documents are issued now.
    const ask = (to: string) =>
      signedRequest({ from: alice, to, type: ASK_REQUEST_TYPE_URI, payload: ASK, at: Date.now() });

    const outcome = async (links: Links) => {
      const { service, handled } = build(links);
      const to = service.vid as string;
      const reply = await service.handle(ask(to));

      return { reply, handled };
    };

    it('admits an AID with an active link that records no key — the key the AID spells out is the key', async () => {
      const { reply, handled } = await outcome({ [alice.vid]: [{ peerKeyJwk: null }] });

      expect(reply.kind).toBe('document');
      expect(handled).toHaveLength(1);
    });

    it('admits an AID whose link records the very key it spells out', async () => {
      const { reply } = await outcome({ [alice.vid]: [{ peerKeyJwk: aliceKey }] });

      expect(reply.kind).toBe('document');
    });

    it('refuses an AID whose link records a DIFFERENT key — the key the link records always wins', async () => {
      const other = sovereignJwk(newParty().vid);
      const { reply, handled } = await outcome({ [alice.vid]: [{ peerKeyJwk: other }] });

      expect(reply).toEqual({ kind: 'refused' });
      expect(handled).toHaveLength(0);
    });

    it('refuses an AID with no active link at all', async () => {
      expect((await outcome({})).reply).toEqual({ kind: 'refused' });
    });

    it('treats a malformed recorded key as a mismatch, not a pass', async () => {
      expect((await outcome({ [alice.vid]: [{ peerKeyJwk: { kty: 'OKP' } }] })).reply).toEqual({
        kind: 'refused',
      });
    });

    it('does not touch the link table for a string that is not shaped like an AID', async () => {
      const { service, lookups } = build();

      for (const vid of [
        '',
        'did:key:z6Mk',
        'did:keri:E' + 'A'.repeat(43),
        'did:keri:D' + 'A'.repeat(42),
        alice.vid + '!',
      ]) {
        expect(await admits(service, vid)).toBe(false);
      }

      expect(lookups).toEqual([]);
    });

    it('refuses an AID that spells a small-order key even when the owner has linked it', async () => {
      const allZero = `did:keri:D${'A'.repeat(43)}`;
      const { service, lookups } = build({ [allZero]: [{ peerKeyJwk: null }] });

      expect(await admits(service, allZero)).toBe(false);
      expect(lookups).toEqual([allZero]);
    });

    it('looks the AID up once and admits the linked one', async () => {
      const { service, lookups } = build({ [alice.vid]: [{ peerKeyJwk: null }] });

      expect(await admits(service, alice.vid)).toBe(true);
      expect(lookups).toEqual([alice.vid]);
    });

    it('admits when ANY active link qualifies', async () => {
      const other = sovereignJwk(newParty().vid);

      expect((await outcome({ [alice.vid]: [{ peerKeyJwk: other }, { peerKeyJwk: null }] })).reply.kind).toBe(
        'document',
      );
    });
  });

  it('answers an admitted peer with a response signed by the box key, and stamps how the ask arrived', async () => {
    const alice = newParty();
    const { jwk } = boxKey();
    const { service, handled } = build({ [alice.vid]: [{ peerKeyJwk: null }] }, JSON.stringify(jwk));

    const reply = await service.handle(
      signedRequest({
        from: alice,
        to: service.vid as string,
        type: ASK_REQUEST_TYPE_URI,
        payload: ASK,
        at: Date.now(),
      }),
    );

    expect(reply.kind).toBe('document');

    const { document } = reply as Extract<typeof reply, { kind: 'document' }>;
    const boxPublic = new Uint8Array(Buffer.from(jwk.x as string, 'base64url'));
    expect(verifyEddsaJcs2022Proof(document, boxPublic)).toBe(true);
    expect(document.issuer).toBe(service.vid);

    const [identity, , channel] = handled[0] as [
      unknown,
      unknown,
      { keyThumbprint: string; covered: string[] },
    ];
    expect(identity).toEqual({ issuer: 'did:keri', subject: alice.vid });
    expect(channel.keyThumbprint).toBe(jwkThumbprint(sovereignJwk(alice.vid) as Record<string, unknown>));
    expect(channel.covered).toEqual(['trust-task:eddsa-jcs-2022']);
  });
});
