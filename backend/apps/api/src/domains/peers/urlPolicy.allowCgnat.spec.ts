/**
 * `peers.allowCgnatEndpoints` wired to the REAL `@ci/configuration` module —
 * the plumbing `urlPolicy.spec.ts`'s options-based tests cannot reach, since
 * those pass `{ allowCgnat }` explicitly rather than through config.
 *
 * `checkEgressUrl` / `isEgressUrlAllowed` are pure and never read config
 * themselves — only their CALLER decides whether to pass `{ allowCgnat }`.
 * `peerEgressFetch` is the one production caller that does, reading the live
 * value on every call, so it is the only function this file needs to exercise
 * to prove the flag is actually wired to config rather than merely plumbed
 * through an option nothing sets.
 *
 * Config is mocked to `true` BEFORE `./urlPolicy` is imported below, because
 * the `peerEgressLookup` singleton (built once, at module load — see its doc
 * comment in `urlPolicy.ts`) needs the same value `peerEgressFetch` reads per
 * call, or the pre-flight check and the connect-time guard could disagree.
 * That ordering requirement is the same one `PeerSignatureService.spec.ts`
 * and `PeerDirectoryService.spec.ts` already rely on for `peers.signingKeyJwk`
 * / `peers.directoryUrl`. This lives in its OWN file, rather than a second
 * `describe` block inside `urlPolicy.spec.ts`, because jest gives each test
 * FILE a fresh module registry — one file cannot bake in both `true` and the
 * default `false` for the same module-scope constant.
 */
jest.mock('@ci/configuration', () => ({
  __esModule: true,
  default: {
    peers: { allowCgnatEndpoints: true, timeoutMs: 10_000 },
  },
}));

jest.mock('undici', () => {
  const actual = jest.requireActual('undici');

  return { __esModule: true, ...actual, fetch: jest.fn() };
});

import { fetch as undiciFetch } from 'undici';

import { EgressBlockedError, peerEgressFetch } from './urlPolicy';

const mockFetch = undiciFetch as unknown as jest.Mock;

function respond(status: number, json: unknown = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: new Map<string, string>(),
    body: { cancel: jest.fn().mockResolvedValue(undefined) },
    json: async () => json,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('peerEgressFetch wired through real config (CI_PEER_ALLOW_CGNAT_ENDPOINTS=true)', () => {
  it('clears the pre-flight gate for a CGNAT peer and reaches the network — the exact call that used to throw "Peer endpoint not permitted" before this flag existed', async () => {
    mockFetch.mockResolvedValue(respond(200, { status: 'answered' }));

    const response = await peerEgressFetch('https://100.64.3.4/agent/v1/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still refuses an RFC1918 peer even with the flag on — never reaches fetch at all', async () => {
    await expect(
      peerEgressFetch('https://10.0.0.5/agent/v1/ask', { method: 'POST', headers: {} }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still refuses loopback even with the flag on — never reaches fetch at all', async () => {
    await expect(
      peerEgressFetch('https://127.0.0.1/agent/v1/ask', { method: 'POST', headers: {} }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('still refuses link-local / cloud metadata even with the flag on', async () => {
    await expect(
      peerEgressFetch('https://169.254.169.254/agent/v1/ask', { method: 'POST', headers: {} }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
