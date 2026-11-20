import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { LlmEndpointPreflight } from '@/hooks/useLlmEndpoint';

import { EndpointCheckMessage } from './EndpointCheckMessage';

const base = { backend: 'ollama' as const, endpoint: 'http://host.docker.internal:11434', models: [] };

function renderResult(preflight: LlmEndpointPreflight) {
  render(
    <p role="status">
      <EndpointCheckMessage preflight={preflight} />
    </p>,
  );

  return screen.getByRole('status');
}

describe('EndpointCheckMessage', () => {
  it('shows the firewall rule as its own block of code after the message', () => {
    const command = 'sudo ufw allow from 172.16.0.0/12 to any port 11434 proto tcp';
    const status = renderResult({
      ...base,
      ok: false,
      reason: 'timeout',
      message:
        'host.docker.internal:11434 did not answer in time. If that computer runs Linux with ufw, this rule lets them through:',
      fixCommand: command,
    });

    const code = status.querySelector('code');

    expect(code).toHaveTextContent(command);
    expect(code).toHaveClass('block', 'select-all');
    expect(status.firstChild?.textContent).toMatch(/^host\.docker\.internal:11434 did not answer in time\./);
  });

  it('shows the message alone when there is no command', () => {
    const status = renderResult({
      ...base,
      ok: false,
      reason: 'refused',
      message: 'host.docker.internal:11434 refused the connection.',
    });

    expect(status).toHaveTextContent('host.docker.internal:11434 refused the connection.');
    expect(status.querySelector('code')).toBeNull();
  });

  it('falls back to a plain word when the server sent no message', () => {
    expect(renderResult({ ...base, ok: true })).toHaveTextContent('Connected.');
  });
});
