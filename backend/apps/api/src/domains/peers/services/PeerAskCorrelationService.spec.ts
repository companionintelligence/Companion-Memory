import type { PeerAskBody } from '../protocol';

import { requestDigest } from './PeerAskCorrelationService';

function body(request: PeerAskBody['request'], overrides: Partial<PeerAskBody> = {}): PeerAskBody {
  return { askId: 'corr-0000-1', askerHandle: 'ada', prompt: 'q?', request, ...overrides };
}

/**
 * The digest is what stops one idempotency key answering a different question:
 * without it a peer could reuse a key and be handed the first ask's answer. No
 * NEW disclosure — it already crossed to that same peer — but an answer to a
 * question nobody asked.
 */
describe('requestDigest', () => {
  it('is stable for the same question', () => {
    const request = { archetype: 'content', subject: 'lake trip', dataClass: 'photos' } as const;

    expect(requestDigest(body(request))).toBe(requestDigest(body(request)));
  });

  it('IGNORES key order — the wire is JSON, and JSON does not promise one', () => {
    // Zod preserves insertion order, so two byte-identical requests that listed
    // their fields differently would otherwise digest differently and a
    // legitimate retry would be refused as malformed.
    const a = { archetype: 'availability', from: '2026-09-15T09:00:00.000Z', to: '2026-09-15T17:00:00.000Z' };
    const b = { to: '2026-09-15T17:00:00.000Z', from: '2026-09-15T09:00:00.000Z', archetype: 'availability' };

    expect(requestDigest(body(a as never))).toBe(requestDigest(body(b as never)));
  });

  it('ignores the DISPLAY fields, so a reworded prompt is still the same question', () => {
    const request = { archetype: 'content', subject: 'lake trip', dataClass: 'photos' } as const;

    // Neither the grant evaluator nor the executor reads `prompt` or
    // `askerHandle`; folding them in would refuse a retry over a cosmetic edit.
    expect(requestDigest(body(request, { prompt: 'do you have them?' }))).toBe(
      requestDigest(body(request, { prompt: 'have you got them?' })),
    );
  });

  it('changes when the DATA CLASS changes, which is the whole point', () => {
    const photos = { archetype: 'content', subject: 'lake trip', dataClass: 'photos' } as const;
    const messages = { archetype: 'content', subject: 'lake trip', dataClass: 'messages' } as const;

    expect(requestDigest(body(photos))).not.toBe(requestDigest(body(messages)));
  });

  it('changes when the archetype changes', () => {
    const content = { archetype: 'content', subject: 'Carol' } as const;
    const relationship = { archetype: 'relationship', subject: 'Carol' } as const;

    expect(requestDigest(body(content))).not.toBe(requestDigest(body(relationship)));
  });

  it('changes when an availability window moves', () => {
    const base = {
      archetype: 'availability',
      from: '2026-09-15T09:00:00.000Z',
      to: '2026-09-15T17:00:00.000Z',
    };

    expect(requestDigest(body(base as never))).not.toBe(
      requestDigest(body({ ...base, to: '2026-09-16T17:00:00.000Z' } as never)),
    );
  });
});
