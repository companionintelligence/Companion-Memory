import { isEmptyOrLoopback } from '../../configuration';

/**
 * The dev-only direct wake is loopback-enforced at config PARSE time, so an
 * appliance that somehow had it pointing off-box refuses to boot rather than
 * warning about it. This is that predicate.
 *
 * It matters more than its size suggests: the direct wake sends a bearer token,
 * and misactivation — not the wake itself — is the only way this path weakens
 * anything real.
 */
describe('isEmptyOrLoopback', () => {
  it('accepts empty — the shipped default, which means the path is off', () => {
    expect(isEmptyOrLoopback('')).toBe(true);
  });

  it('accepts the four real loopback forms', () => {
    expect(isEmptyOrLoopback('http://127.0.0.1:18789')).toBe(true);
    expect(isEmptyOrLoopback('http://localhost:18789')).toBe(true);
    expect(isEmptyOrLoopback('http://[::1]:18789')).toBe(true);
    // The container's route back to its own host — loopback in the sense that
    // matters here: it cannot leave the machine.
    expect(isEmptyOrLoopback('http://host.docker.internal:18789')).toBe(true);
  });

  it('rejects hosts that merely CONTAIN a loopback string', () => {
    // Why this is an allowlist on the parsed hostname rather than a pattern
    // match on the URL. Both of these resolve wherever their owner points them,
    // and a substring check would wave both through.
    expect(isEmptyOrLoopback('http://127.0.0.1.evil.com')).toBe(false);
    expect(isEmptyOrLoopback('http://localhost.attacker.net')).toBe(false);
    expect(isEmptyOrLoopback('http://not-localhost')).toBe(false);
  });

  it('rejects anything off-box', () => {
    expect(isEmptyOrLoopback('http://10.0.0.5:18789')).toBe(false);
    expect(isEmptyOrLoopback('https://openclaw.example.com')).toBe(false);
  });

  it('rejects a value that is not a URL at all', () => {
    // "Unparseable" is not "harmless" — it must not fall through to accepted.
    expect(isEmptyOrLoopback('localhost:18789')).toBe(false);
    expect(isEmptyOrLoopback('yes')).toBe(false);
  });
});
