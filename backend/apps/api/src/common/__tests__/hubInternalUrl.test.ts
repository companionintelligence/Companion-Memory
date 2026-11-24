import { DEFAULT_HUB_INTERNAL_URL, resolveHubInternalUrl } from '../../configuration';

/**
 * Where Dispatch rings the Hub. No Hub sets CI_HUB_INTERNAL_URL, and the default Memory had for it,
 * `http://ci-os-hub:3000`, is a port the Hub does not listen on, so OpenClaw was never woken.
 */
describe('resolveHubInternalUrl', () => {
  it('keeps an address an operator set', () => {
    expect(resolveHubInternalUrl('http://hub.test:5002', 'http://ci-hub:5002/api/inference/v1')).toBe(
      'http://hub.test:5002',
    );
  });

  it("takes the Hub's own address from the inference URL every Hub hands its apps", () => {
    expect(resolveHubInternalUrl('', 'http://ci-hub:5002/api/inference/v1')).toBe('http://ci-hub:5002');
    expect(resolveHubInternalUrl(undefined, 'http://ci-os-hub:4100/api/inference/v1')).toBe(
      'http://ci-os-hub:4100',
    );
  });

  it("falls back to the Hub's default address, on the port it listens on", () => {
    expect(DEFAULT_HUB_INTERNAL_URL).toBe('http://ci-os-hub:5002');
    expect(resolveHubInternalUrl('', undefined)).toBe(DEFAULT_HUB_INTERNAL_URL);
    expect(resolveHubInternalUrl('  ', 'not a url')).toBe(DEFAULT_HUB_INTERNAL_URL);
    expect(resolveHubInternalUrl('', 'file:///etc/passwd')).toBe(DEFAULT_HUB_INTERNAL_URL);
  });
});
