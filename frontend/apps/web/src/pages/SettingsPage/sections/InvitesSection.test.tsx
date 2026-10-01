import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InvitesSection } from './InvitesSection';

const h = vi.hoisted(() => ({ authToken: 'jwt-abc' as string | null }));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken }, {}],
}));

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson,
}));

type FetchCalls = Array<[string, { method?: string; headers?: Record<string, string> }?]>;

function signupCodeCalls(method: string): FetchCalls {
  return (fetchJson.mock.calls as FetchCalls).filter(
    ([url, init]) => url === '/api/signup-codes' && (init?.method ?? 'GET') === method,
  );
}

describe('InvitesSection', () => {
  beforeEach(() => {
    h.authToken = 'jwt-abc';
    fetchJson.mockReset();
    fetchJson.mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(init?.method === 'POST' ? { signup_code: 'NEW-CODE' } : [{ signup_code: 'ABC-123' }]),
    );
  });

  // JwtOrApiKeyAuthGuard reads a JWT only from `Authorization: Bearer`, and on
  // the web `apiKeyHeaders()` is empty — without the token both calls 401'd and
  // the owner saw "Unauthorized" instead of their invitations.
  it("lists invitations with the session's Bearer token", async () => {
    render(<InvitesSection />);

    expect(await screen.findByText('ABC-123')).toBeInTheDocument();
    expect(screen.queryByText('Unauthorized')).not.toBeInTheDocument();

    const [[, init]] = signupCodeCalls('GET');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer jwt-abc' });
  });

  it("creates an invitation with the session's Bearer token", async () => {
    render(<InvitesSection />);
    await screen.findByText('ABC-123');

    fireEvent.click(screen.getByRole('button', { name: 'Create an invitation' }));

    await waitFor(() => expect(signupCodeCalls('POST')).toHaveLength(1));
    const [[, init]] = signupCodeCalls('POST');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer jwt-abc' });
  });

  it('loads again with the token once the session has one', async () => {
    h.authToken = null;
    const { rerender } = render(<InvitesSection />);

    await waitFor(() => expect(signupCodeCalls('GET')).toHaveLength(1));
    expect(signupCodeCalls('GET')[0]?.[1]?.headers).not.toHaveProperty('Authorization');

    h.authToken = 'jwt-late';
    rerender(<InvitesSection />);

    await waitFor(() => expect(signupCodeCalls('GET')).toHaveLength(2));
    expect(signupCodeCalls('GET')[1]?.[1]?.headers).toMatchObject({ Authorization: 'Bearer jwt-late' });
  });
});
