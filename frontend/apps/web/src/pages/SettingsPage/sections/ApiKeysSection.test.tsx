import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiKeysSection } from './ApiKeysSection';

// ApiKeysSection reads useAuth from the @/hooks barrel and talks to /api/keys through fetchJson.
const h = vi.hoisted(() => ({
  fetchJson: vi.fn(),
  // The web session: a JWT. The native shell holds only a device API key, so there is no JWT
  // there (`authToken` null) while the session is still `authenticated`.
  authToken: 'token' as string | null,
  authenticated: true,
}));

vi.mock('@/hooks', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated }, {}],
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  fetchJson: h.fetchJson,
}));

afterEach(() => {
  h.authToken = 'token';
  h.authenticated = true;
});

/** The parsed body of the key-creation POST, or undefined if it was never sent. */
function createBody(): Record<string, unknown> | undefined {
  const call = h.fetchJson.mock.calls.find(
    ([url, init]) => url === '/api/keys' && (init as { method?: string } | undefined)?.method === 'POST',
  );

  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

async function openCreateDialogAndName() {
  fireEvent.click(await screen.findByRole('button', { name: /create api key/i }));
  fireEvent.change(await screen.findByLabelText(/^name$/i), { target: { value: 'laptop' } });
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /^create$/i }));
}

describe('ApiKeysSection scope picker', () => {
  beforeEach(() => {
    h.fetchJson.mockReset();
    // Route by method rather than a blanket resolve: the component refetches the list right after
    // creating, and handing that GET the create response makes it render-crash on keys.map.
    h.fetchJson.mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(init?.method === 'POST' ? { id: '1', key: 'raw-key' } : []),
    );
  });

  it('omits scopes when nothing is selected, preserving the full-access default', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    submit();

    await waitFor(() => expect(createBody()).toBeDefined());
    // Absent rather than an empty array — an omitted field keeps the grandfathered meaning.
    expect(createBody()).not.toHaveProperty('scopes');
  });

  it('sends only the selected scopes', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    fireEvent.click(screen.getByLabelText('MCP'));
    submit();

    await waitFor(() => expect(createBody()).toBeDefined());
    expect(createBody()?.scopes).toEqual(['mcp']);
  });

  it('accumulates scopes and drops one when unchecked', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    fireEvent.click(screen.getByLabelText('Memory'));
    fireEvent.click(screen.getByLabelText('MCP'));
    fireEvent.click(screen.getByLabelText('Memory'));
    submit();

    await waitFor(() => expect(createBody()).toBeDefined());
    expect(createBody()?.scopes).toEqual(['mcp']);
  });

  it('announces what each scope unlocks, not just its name', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    // The description has to reach assistive tech as the checkbox's description. Naming the box
    // with aria-label instead would drop it, leaving "MCP" with no statement of what it grants.
    const mcp = screen.getByRole('checkbox', { name: 'MCP' });

    expect(mcp).toHaveAccessibleDescription(
      'Reach the Model Context Protocol endpoint (/api/mcp) — pair with Intents to see any tools',
    );
  });

  // A key with `mcp` and no `intents` authenticates, opens a session, and advertises zero tools.
  // Agents surface that as "this server has no tools", so the dialog has to say it up front —
  // otherwise the picker's most obvious selection is also its most broken one.
  it('warns that MCP without Intents advertises no tools', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    expect(screen.queryByText(/advertises no tools/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('MCP'));

    expect(screen.getByText(/MCP alone advertises no tools/i)).toBeInTheDocument();
  });

  it('announces the warning rather than showing it only in amber', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    fireEvent.click(screen.getByLabelText('MCP'));

    // The warning appears after render, so it reaches a screen reader only from a live region.
    // Without one it is visible-only and the broken combination gets picked in silence.
    expect(screen.getByText(/MCP alone advertises no tools/i).closest('[role="status"]')).toBeInTheDocument();
  });

  it('drops the warning once Intents is added, and when MCP is removed', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    fireEvent.click(screen.getByLabelText('MCP'));
    fireEvent.click(screen.getByLabelText('Intents'));

    expect(screen.queryByText(/advertises no tools/i)).not.toBeInTheDocument();

    // Removing Intents brings it back — the pair is what matters, not the order they were picked.
    fireEvent.click(screen.getByLabelText('Intents'));
    expect(screen.getByText(/MCP alone advertises no tools/i)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('MCP'));
    expect(screen.queryByText(/advertises no tools/i)).not.toBeInTheDocument();
  });

  // Memory alone must not trigger it — the warning is specific to the MCP tool surface.
  it('does not warn for a scope selection that has nothing to do with MCP', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    fireEvent.click(screen.getByLabelText('Memory'));

    expect(screen.queryByText(/advertises no tools/i)).not.toBeInTheDocument();
  });

  it('clears the selection when the dialog is cancelled', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();
    fireEvent.click(screen.getByLabelText('MCP'));

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // Reopening must not carry the previous selection: a stale scope would mint a
    // limited key while the user believed it had full access.
    await openCreateDialogAndName();
    submit();

    await waitFor(() => expect(createBody()).toBeDefined());
    expect(createBody()).not.toHaveProperty('scopes');
  });
});

/**
 * Capability is the second axis: scopes say WHICH surfaces a key reaches, capability says what it
 * may do there. Unlike scopes it is always sent — there is no "unset" reading of an authority
 * level, and stating it makes the key's powers a decision rather than a default nobody saw.
 */
describe('ApiKeysSection capability picker', () => {
  beforeEach(() => {
    h.fetchJson.mockReset();
    h.fetchJson.mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(init?.method === 'POST' ? { id: '1', key: 'raw-key' } : []),
    );
  });

  it("defaults to 'write' — what every key could already do", async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    submit();

    await waitFor(() => expect(createBody()).toBeDefined());
    expect(createBody()?.capability).toBe('write');
  });

  it('mints at the chosen level, so a read-only key is never wide open in between', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    fireEvent.click(screen.getByRole('radio', { name: 'Read-only' }));
    submit();

    await waitFor(() => expect(createBody()).toBeDefined());
    expect(createBody()?.capability).toBe('read');
  });

  it('announces what each level permits, not just its name', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    // Same reason as the scope checkboxes: an aria-label naming the radio would suppress the
    // description, leaving "Full access" with no statement of what it permits.
    expect(screen.getByRole('radio', { name: 'Read, write & delete' })).toHaveAccessibleDescription(
      'Also delete memories and other stored data, merge people and make edits that remove data. Deletions cannot be undone.',
    );
    // Editing a person's contacts or renaming a tag can drop data and needs delete; saying "update
    // existing ones" here promised edits a write key is refused.
    expect(screen.getByRole('radio', { name: 'Read & write' })).toHaveAccessibleDescription(
      'Also record new memories and make most edits. An edit that can remove something, such as changing a person’s contact details or renaming a tag, needs “Read, write & delete”.',
    );
  });

  // Capability is enforced on every operation a key can reach (a route's declared level, else the level
  // its shape implies), so read-only holds for an unscoped key too. The note says so, and says what
  // picking areas adds on top — which is why it only shows for read-only with no areas selected.
  it('explains what read-only covers when it is picked with no areas selected', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    expect(screen.queryByText(/Read-only applies everywhere this key can reach/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Read-only' }));

    expect(screen.getByText(/Read-only applies everywhere this key can reach/i)).toBeInTheDocument();

    // Once an area is picked the key is confined, and the note has nothing left to add.
    fireEvent.click(screen.getByLabelText('Memory'));
    expect(screen.queryByText(/Read-only applies everywhere this key can reach/i)).not.toBeInTheDocument();
  });

  it('does not show the read-only note for write or full', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();

    fireEvent.click(screen.getByRole('radio', { name: 'Read, write & delete' }));

    expect(screen.queryByText(/Read-only applies everywhere this key can reach/i)).not.toBeInTheDocument();
  });

  it('resets to the default when the dialog is cancelled', async () => {
    render(<ApiKeysSection />);
    await openCreateDialogAndName();
    fireEvent.click(screen.getByRole('radio', { name: 'Read, write & delete' }));

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));

    // A 'full' chosen for one key must not silently carry into the next.
    await openCreateDialogAndName();
    submit();

    await waitFor(() => expect(createBody()).toBeDefined());
    expect(createBody()?.capability).toBe('write');
  });
});

/** The parsed body of the PATCH to a key, or undefined if none was sent. */
function patchBody(id: string): Record<string, unknown> | undefined {
  const call = h.fetchJson.mock.calls.find(
    ([url, init]) =>
      url === `/api/keys/${id}` && (init as { method?: string } | undefined)?.method === 'PATCH',
  );

  return call ? JSON.parse((call[1] as { body: string }).body) : undefined;
}

describe('ApiKeysSection capability changes', () => {
  const key = {
    id: 'k1',
    name: 'laptop',
    prefix: 'ab12c',
    scopes: ['memory'],
    capability: 'write',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    managed_by: null,
  };

  const mockKeys = (rows: unknown[]) => {
    h.fetchJson.mockReset();
    h.fetchJson.mockImplementation((_url: string, init?: { method?: string }) =>
      Promise.resolve(init?.method ? {} : rows),
    );
  };

  const openEdit = async (name: string) =>
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`edit ${name}`, 'i') }));

  it('badges each key with what it can do, so a row never says only where it reaches', async () => {
    mockKeys([key, { ...key, id: 'k2', name: 'importer', scopes: [], capability: 'full' }]);
    render(<ApiKeysSection />);

    expect(await screen.findByText('Read & write')).toBeInTheDocument();
    // Distinct from the "Full access" scope badge the same row carries for an empty scope set:
    // that one says where the key reaches, this one says what it may do there.
    expect(screen.getByText('Read, write & delete')).toBeInTheDocument();
    expect(screen.getByText('Full access')).toBeInTheDocument();
  });

  it('narrows a key without a confirmation — tightening only ever removes authority', async () => {
    mockKeys([key]);
    render(<ApiKeysSection />);
    await openEdit('laptop');

    fireEvent.click(await screen.findByRole('radio', { name: 'Read-only' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(patchBody('k1')).toBeDefined());
    expect(patchBody('k1')?.capability).toBe('read');
  });

  it('requires a confirmation naming the key before widening it', async () => {
    mockKeys([key]);
    render(<ApiKeysSection />);
    await openEdit('laptop');

    fireEvent.click(await screen.findByRole('radio', { name: 'Read, write & delete' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    // Nothing written yet — Save on a promotion opens the confirmation instead.
    expect(patchBody('k1')).toBeUndefined();
    expect(screen.getByText(/“laptop” delete your data/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /grant access/i }));

    await waitFor(() => expect(patchBody('k1')).toBeDefined());
    expect(patchBody('k1')?.capability).toBe('full');
  });

  it('backing out of the confirmation writes nothing', async () => {
    mockKeys([key]);
    render(<ApiKeysSection />);
    await openEdit('laptop');

    fireEvent.click(await screen.findByRole('radio', { name: 'Read, write & delete' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));

    expect(screen.getByRole('button', { name: /^save$/i })).toBeInTheDocument();
    expect(patchBody('k1')).toBeUndefined();
  });

  // A Hub-managed key's NAME is not the user's to change (Hub revokes by name, so a rename would
  // strand the connection), but what it may do with the user's own data is.
  it('lets a Hub-managed key be narrowed without offering a rename', async () => {
    mockKeys([{ ...key, name: 'app:ci-hermes:ci-marketplace', managed_by: 'connect' }]);
    render(<ApiKeysSection />);
    await openEdit('app:ci-hermes:ci-marketplace');

    expect(await screen.findByLabelText(/^name$/i)).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: 'Read-only' }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(patchBody('k1')).toBeDefined());
    expect(patchBody('k1')).toEqual({ capability: 'read' });
  });

  it('falls back to the column default for a key the API returned without a capability', async () => {
    // A row from an API that predates the column. Rendering nothing would show an unrestricted key
    // as if it carried no authority at all.
    mockKeys([{ ...key, capability: undefined }]);
    render(<ApiKeysSection />);

    expect(await screen.findByText('Read & write')).toBeInTheDocument();
  });
});

describe('ApiKeysSection delete confirmation', () => {
  const key = {
    id: 'k1',
    name: 'laptop',
    prefix: 'ab12c',
    scopes: ['memory'],
    capability: 'write',
    expires_at: null,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    managed_by: null,
  };

  /**
   * Unlike `mockKeys` (which hands back the same array for every GET), this
   * tracks a mutable list so a successful DELETE is reflected the next time
   * `fetchKeys()` refetches — the only way to prove the row actually left the
   * list rather than merely that a DELETE was sent.
   */
  function mockKeysWithDelete(initial: Array<Record<string, unknown>>) {
    let current = initial;
    h.fetchJson.mockReset();
    h.fetchJson.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') {
        const id = url.split('/').pop();
        current = current.filter((k) => k.id !== id);

        return Promise.resolve({});
      }

      return Promise.resolve(init?.method ? {} : current);
    });
  }

  const openDeleteFor = async (name: string) =>
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`delete ${name}`, 'i') }));

  it('opens a confirmation naming the key before sending anything', async () => {
    mockKeysWithDelete([key]);
    render(<ApiKeysSection />);
    await openDeleteFor('laptop');

    expect(screen.getByText('Delete API Key')).toBeInTheDocument();
    // The key's name is bolded inline (`<strong>{name}</strong>`), so it lands in its
    // own text node — one occurrence in the row behind the dialog, one in the prompt.
    expect(screen.getAllByText('laptop').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/any integrations using this key will stop working/i)).toBeInTheDocument();
    expect(
      h.fetchJson.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
  });

  it('cancel leaves the key in place and sends no DELETE', async () => {
    mockKeysWithDelete([key]);
    render(<ApiKeysSection />);
    await openDeleteFor('laptop');

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(
      h.fetchJson.mock.calls.some(
        ([, init]) => (init as { method?: string } | undefined)?.method === 'DELETE',
      ),
    ).toBe(false);
    expect(screen.getByText('laptop')).toBeInTheDocument();
  });

  it('sends a DELETE for the key and drops it from the list on success', async () => {
    mockKeysWithDelete([key, { ...key, id: 'k2', name: 'phone' }]);
    render(<ApiKeysSection />);
    await screen.findByText('laptop');

    await openDeleteFor('laptop');
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    await waitFor(() =>
      expect(h.fetchJson).toHaveBeenCalledWith('/api/keys/k1', expect.objectContaining({ method: 'DELETE' })),
    );
    // The list is re-fetched after a successful delete, and the row is gone —
    // proving the deletion actually took, not just that the request fired.
    await waitFor(() => expect(screen.queryByText('laptop')).not.toBeInTheDocument());
    expect(screen.getByText('phone')).toBeInTheDocument();
  });

  it('shows "Failed to delete API key" and keeps the key listed when the request fails', async () => {
    h.fetchJson.mockReset();
    h.fetchJson.mockImplementation((_url: string, init?: { method?: string }) => {
      if (init?.method === 'DELETE') {
        return Promise.reject(new Error('network down'));
      }

      return Promise.resolve(init?.method ? {} : [key]);
    });

    render(<ApiKeysSection />);
    await openDeleteFor('laptop');
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText('Failed to delete API key')).toBeInTheDocument();
    // Nothing was actually removed — the row (and the dialog's own mention of
    // its name) both stay put, ready to retry, rather than closing as if the
    // delete had gone through.
    expect(screen.getAllByText('laptop').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Delete API Key')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^delete$/i })).toBeEnabled();
  });

  it('warns before deleting a Hub-managed key, pointing at Disconnect Memory instead', async () => {
    mockKeysWithDelete([{ ...key, managed_by: 'connect', name: 'app:ci-hermes:ci-marketplace' }]);
    render(<ApiKeysSection />);
    await openDeleteFor('app:ci-hermes:ci-marketplace');

    expect(screen.getByText(/managed by Companion Hub for a connected app/i)).toBeInTheDocument();
    expect(screen.getByText(/Disconnect Memory/)).toBeInTheDocument();
  });

  it('does not warn about Hub management for a key the user owns', async () => {
    mockKeysWithDelete([key]);
    render(<ApiKeysSection />);
    await openDeleteFor('laptop');

    expect(screen.queryByText(/managed by Companion Hub/i)).not.toBeInTheDocument();
  });
});

/**
 * ═══ "FAILED TO LOAD API KEYS" AND "NO API KEYS CREATED YET" AT ONCE ═══
 *
 * A failed load leaves `keys` empty, and the empty state keyed off `keys` alone — so the red
 * banner said the list could not be read while the card under it said there was nothing to read.
 */
describe('ApiKeysSection load failure', () => {
  beforeEach(() => {
    h.authToken = 'token';
    h.authenticated = true;
    h.fetchJson.mockReset();
  });

  it('does not claim there are no keys when the list could not be loaded', async () => {
    h.fetchJson.mockRejectedValue(new Error('network down'));

    render(<ApiKeysSection />);

    expect(await screen.findByText('Failed to load API keys')).toBeInTheDocument();
    expect(screen.queryByText('No API keys created yet.')).not.toBeInTheDocument();
  });

  it('still shows the empty state when the load succeeded and there are none', async () => {
    h.fetchJson.mockResolvedValue([]);

    render(<ApiKeysSection />);

    expect(await screen.findByText('No API keys created yet.')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load API keys')).not.toBeInTheDocument();
  });

  it('keeps the empty state when only a later action failed', async () => {
    // A failed create sets the same banner, but the list itself loaded fine and is empty.
    h.fetchJson.mockImplementation((_url: string, init?: { method?: string }) =>
      init?.method === 'POST' ? Promise.reject(new Error('nope')) : Promise.resolve([]),
    );

    render(<ApiKeysSection />);
    await openCreateDialogAndName();
    submit();

    expect(await screen.findByText('Failed to create API key')).toBeInTheDocument();
    expect(screen.getByText('No API keys created yet.')).toBeInTheDocument();
  });
});

/**
 * ═══ A SCREEN THE PHONE CAN NEVER USE ═══
 *
 * `/api/keys` is `JwtOrPortalAuthGuard`, deliberately never an API key — a leaked key that could
 * mint replacement keys would outlive its own revocation. The native shell holds only a device
 * key (no web JWT), so the request could only 401, and the page then said "Failed to load API
 * keys" above "No API keys created yet." Say what is true instead, and do not send the request.
 */
describe('ApiKeysSection on the native shell (device key, no web JWT)', () => {
  beforeEach(() => {
    h.authToken = null;
    h.authenticated = true;
    h.fetchJson.mockReset();
    h.fetchJson.mockResolvedValue([]);
  });

  it('says plainly that a web sign-in is needed', () => {
    render(<ApiKeysSection />);

    expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument();
    expect(screen.getByText(/never allowed to mint or revoke keys/i)).toBeInTheDocument();
  });

  it('does not send a request that can only 401, and shows no load failure or empty state', async () => {
    render(<ApiKeysSection />);

    // Let any effect settle before asserting nothing happened.
    await waitFor(() => expect(screen.getByText('Needs a web sign-in')).toBeInTheDocument());

    expect(h.fetchJson).not.toHaveBeenCalled();
    expect(screen.queryByText('Failed to load API keys')).not.toBeInTheDocument();
    expect(screen.queryByText('No API keys created yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create api key/i })).not.toBeInTheDocument();
  });

  it('keeps the normal page for a web session', async () => {
    h.authToken = 'token';

    render(<ApiKeysSection />);

    expect(await screen.findByText('No API keys created yet.')).toBeInTheDocument();
    expect(screen.queryByText('Needs a web sign-in')).not.toBeInTheDocument();
  });
});
