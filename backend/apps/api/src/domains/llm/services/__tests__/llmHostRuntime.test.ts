import { resolveLlmUrlForRuntime } from '../llmEndpointShared';

/**
 * `LLM_API_BASE` is written once, in `.env`, and read from both sides of a
 * container boundary: this API on the host under `make dev` and in a container
 * under staging/production compose, plus the two python sidecars, which are
 * always containers. `http://localhost:11434/v1` is right for a host process and
 * names the container itself inside one; `http://host.docker.internal:11434/v1`
 * is right for a container and resolves nowhere on a macOS or linux host. So
 * whichever spelling `.env` holds, the other side is silently pointed at
 * nothing — and because compose interpolates `${LLM_API_BASE:-<good default>}`,
 * a set-but-wrong value beats the correct default the repo ships.
 *
 * Observed live 2026-08-30: summary-service refusing every connection, and HBPE
 * writing zero labels across a full nightly run (#2484).
 */
const inContainer = { inContainer: true, gatewayPresent: () => true };
const onHost = { inContainer: false, gatewayPresent: () => false };

describe('resolveLlmUrlForRuntime', () => {
  describe('the two directions', () => {
    it('rewrites a loopback host to the gateway inside a container', () => {
      const { url, note } = resolveLlmUrlForRuntime('http://localhost:11434/v1', inContainer);

      expect(url).toBe('http://host.docker.internal:11434/v1');
      expect(note).toBeDefined();
    });

    it('rewrites the gateway to loopback on the host', () => {
      const { url, note } = resolveLlmUrlForRuntime('http://host.docker.internal:11434/v1', onHost);

      expect(url).toBe('http://localhost:11434/v1');
      expect(note).toBeDefined();
    });

    it('leaves a loopback host alone on the host', () => {
      // The ordinary `make dev` case: api and worker run under overmind, and
      // Ollama really is on localhost.
      expect(resolveLlmUrlForRuntime('http://localhost:11434/v1', onHost)).toEqual({
        url: 'http://localhost:11434/v1',
      });
    });

    it('leaves the gateway alone inside a container that can reach it', () => {
      expect(resolveLlmUrlForRuntime('http://host.docker.internal:11434/v1', inContainer)).toEqual({
        url: 'http://host.docker.internal:11434/v1',
      });
    });
  });

  describe('what survives a rewrite', () => {
    it('keeps a non-Ollama port and the /v1 path', () => {
      expect(resolveLlmUrlForRuntime('http://localhost:8000/v1', inContainer).url).toBe(
        'http://host.docker.internal:8000/v1',
      );
    });

    it('does not add a trailing slash', () => {
      // OLLAMA_HOST is concatenated onto (`${host}/api/tags`), so an added slash
      // is a broken path, not a cosmetic difference. This is why the swap is
      // textual rather than via URL#toString.
      expect(resolveLlmUrlForRuntime('http://localhost:11434', inContainer).url).toBe(
        'http://host.docker.internal:11434',
      );
    });

    it('keeps scheme, userinfo and query', () => {
      expect(resolveLlmUrlForRuntime('https://u:p@localhost:8443/v1?x=1', inContainer).url).toBe(
        'https://u:p@host.docker.internal:8443/v1?x=1',
      );
    });

    it('does not invent a default port', () => {
      expect(resolveLlmUrlForRuntime('http://localhost/v1', inContainer).url).toBe(
        'http://host.docker.internal/v1',
      );
    });
  });

  describe('values that are none of our business', () => {
    it.each(['http://ollama:11434/v1', 'https://api.example.com/v1'])(
      'never touches the real hostname %s',
      (base) => {
        expect(resolveLlmUrlForRuntime(base, inContainer)).toEqual({ url: base });
        expect(resolveLlmUrlForRuntime(base, onHost)).toEqual({ url: base });
      },
    );

    it.each([undefined, '', '   ', 'not a url'])('passes %p through', (value) => {
      expect(resolveLlmUrlForRuntime(value, inContainer).note).toBeUndefined();
    });

    it('honours the CI_LLM_HOST_REWRITE=off escape hatch', () => {
      expect(
        resolveLlmUrlForRuntime('http://localhost:11434/v1', {
          ...inContainer,
          env: { CI_LLM_HOST_REWRITE: 'off' } as NodeJS.ProcessEnv,
        }),
      ).toEqual({ url: 'http://localhost:11434/v1' });
    });

    it('takes an operator-supplied gateway at its word', () => {
      // An overridden gateway may be a real DNS name, which /etc/hosts would
      // never list — so it is used without the presence check.
      expect(
        resolveLlmUrlForRuntime('http://localhost:11434/v1', {
          inContainer: true,
          gatewayPresent: () => false,
          env: { CI_LLM_HOST_GATEWAY: 'docker-host.internal' } as NodeJS.ProcessEnv,
        }).url,
      ).toBe('http://docker-host.internal:11434/v1');
    });
  });

  describe('when nothing can be fixed, say so anyway', () => {
    it('warns instead of rewriting when a container has no route to the host', () => {
      const { url, note } = resolveLlmUrlForRuntime('http://localhost:11434/v1', {
        inContainer: true,
        gatewayPresent: () => false,
      });

      expect(url).toBe('http://localhost:11434/v1');
      expect(note).toContain('extra_hosts');
    });

    it('does not substitute loopback for an unreachable gateway inside a container', () => {
      // localhost would be flatly wrong there — it is the container itself.
      const { url, note } = resolveLlmUrlForRuntime('http://host.docker.internal:11434/v1', {
        inContainer: true,
        gatewayPresent: () => false,
      });

      expect(url).toBe('http://host.docker.internal:11434/v1');
      expect(note).toContain('extra_hosts');
    });
  });
});
