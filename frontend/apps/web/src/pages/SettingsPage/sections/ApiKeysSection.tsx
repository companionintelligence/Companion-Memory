import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import {
  API_KEY_CAPABILITIES,
  API_KEY_CAPABILITY_FULL,
  API_KEY_CAPABILITY_READ,
  API_KEY_CAPABILITY_WRITE,
  API_KEY_PROVENANCE_CONNECT,
  API_KEY_SCOPE_CAPTURE,
  API_KEY_SCOPE_INTENTS,
  API_KEY_SCOPE_MCP,
  API_KEY_SCOPE_MEMORY,
  DEFAULT_API_KEY_CAPABILITY,
  isApiKeyCapabilityPromotion,
  type ApiKeyCapability,
} from '@ci/common/src/constants';
import {
  Badge,
  Button,
  Calendar,
  Card,
  Checkbox,
  Dialog,
  IconButton,
  Input,
  Label,
  Popover,
  RadioGroup,
} from '@ci/shadcn';
import { CalendarIcon, Check, ClipboardCopy, KeyRound, Lock, Pencil, Plus, Trash, X } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/hooks';

interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  /** What the key may DO on the surfaces its scopes reach: 'read' | 'write' | 'full'. */
  capability: ApiKeyCapability;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  /** Who owns the key's lifecycle: null = the user's own; 'connect' = CI-Hub's. */
  managed_by: string | null;
}

interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string;
}

/**
 * Scopes a user-created key can carry, labelled for the create dialog.
 *
 * Enforcement is deny-by-default on a NON-EMPTY selection: a scoped key may only reach routes that
 * declare one of its scopes. Leaving every box unchecked omits `scopes` from the request, which the
 * API reads as the grandfathered "full access" case — and stays the default, because endpoints
 * without a declared scope (bulk ingest, GraphQL) refuse scoped keys outright.
 *
 * Paths are the ones a client actually calls, which are `/api/`-prefixed across the board — the
 * gateway rewrites `^/api/(.*)` to `/$1`, so `/api/mcp` and `/api/memory` reach controllers mounted
 * at `mcp` and `memory`. Quoting the mount points instead would print a path no client uses: the
 * agent plugins call `/api/memory/{context,recall,turn,write}`, and the MCP examples in
 * `docs/api/auth-and-conventions.md` connect to `/api/mcp`.
 */
const SCOPE_OPTIONS = [
  { value: API_KEY_SCOPE_MEMORY, label: 'Memory', description: 'Read and write memories (/api/memory)' },
  {
    value: API_KEY_SCOPE_INTENTS,
    label: 'Intents',
    description: 'The agent intent catalog (/api/intents), and the tools an MCP client sees',
  },
  {
    value: API_KEY_SCOPE_MCP,
    label: 'MCP',
    description: 'Reach the Model Context Protocol endpoint (/api/mcp) — pair with Intents to see any tools',
  },
  {
    value: API_KEY_SCOPE_CAPTURE,
    label: 'Capture',
    description:
      'Send observations in: bulk ingest (/api/v1) and file uploads (/api/files). Writes only, reads nothing back',
  },
] as const;

/**
 * What a key may DO on the surfaces its scopes reach — a separate axis from the scope checkboxes
 * above, and a genuine choice where the scopes are a set.
 *
 * A radio group rather than a dropdown: these are three levels of authority, not interchangeable
 * settings, and each needs its consequence stated beside it. A collapsed select would hide exactly
 * the sentence that makes the choice an informed one.
 */
const CAPABILITY_OPTIONS = [
  {
    value: API_KEY_CAPABILITY_READ,
    label: 'Read-only',
    description: 'Search and read memories. Cannot record, change or delete them.',
  },
  {
    value: API_KEY_CAPABILITY_WRITE,
    label: 'Read & write',
    description: 'Also record new memories and update existing ones.',
  },
  {
    value: API_KEY_CAPABILITY_FULL,
    // NOT "Full access". On this screen that phrase already means something else — the badge on a
    // key with no scopes, i.e. full *surface* — and one row can carry both. Two different powers
    // under one phrase, side by side, is the ambiguity worth spending words to avoid.
    //
    // CI-Hub uses this same wording for the same stored value, so a user who grants an agent access
    // to both appliances meets one vocabulary rather than two dialects.
    label: 'Read, write & delete',
    description: 'Also delete memories and other stored data. Deletions cannot be undone.',
  },
] as const;

const CAPABILITY_LABELS: Record<ApiKeyCapability, string> = {
  [API_KEY_CAPABILITY_READ]: 'Read-only',
  [API_KEY_CAPABILITY_WRITE]: 'Read & write',
  [API_KEY_CAPABILITY_FULL]: 'Read, write & delete',
};

/**
 * Three steps of one escalating scale: inert → ordinary → caution.
 *
 * All three are styled. Leaving `read` and `write` unstyled made them render identically, so the
 * badge distinguished only the top level — on a row carrying several scope badges too, two of the
 * three answers to "what may this key do" looked the same as each other and as everything beside
 * them.
 *
 * Amber rather than destructive red for `full`, matching CI-Hub: red belongs to the delete action on
 * the same row, and a key the user deliberately granted delete rights is not an error.
 */
const CAPABILITY_BADGE_CLASS: Record<ApiKeyCapability, string> = {
  [API_KEY_CAPABILITY_READ]: 'border-border bg-muted text-muted-foreground',
  [API_KEY_CAPABILITY_WRITE]: 'border-primary/30 bg-primary/10 text-primary',
  [API_KEY_CAPABILITY_FULL]: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
};

/**
 * Read a key's capability defensively. A key row fetched from an API that predates the column, or
 * from a rolled-back deploy, has no value — and rendering nothing there would show an unrestricted
 * key as if it carried no authority at all. Fall back to the level the column defaults to.
 */
function capabilityOf(key: { capability?: ApiKeyCapability | null }): ApiKeyCapability {
  return key.capability && API_KEY_CAPABILITIES.includes(key.capability)
    ? key.capability
    : DEFAULT_API_KEY_CAPABILITY;
}

// Companion Hub mints one key per connected app when you "Connect Memory" from
// the Hub. These are lifecycle-owned by the Hub — it rotates and revokes them —
// so the UI badges them and blocks renaming (a rename would orphan the Hub's
// revoke and strand the key).
//
// Read the server's recorded provenance rather than re-deriving it from the name
// and scopes. Those drift from the truth in both directions: a connect key can
// hold an EMPTY scope set (the bulk importer's does), which the old scope check
// missed — so the UI offered an Edit button the API then rejected — and a user's
// own key named `app:...` was wrongly badged as the Hub's.
function isHubManagedKey(key: { managed_by?: string | null }): boolean {
  return key.managed_by === API_KEY_PROVENANCE_CONNECT;
}

export function ApiKeysSection() {
  const { t } = useTranslation();
  const [{ authToken }] = useAuth();

  const [keys, setKeys] = useState<ApiKeyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createExpiresAt, setCreateExpiresAt] = useState<Date | undefined>(undefined);
  const [createScopes, setCreateScopes] = useState<string[]>([]);
  const [createCapability, setCreateCapability] = useState<ApiKeyCapability>(DEFAULT_API_KEY_CAPABILITY);
  const [createLoading, setCreateLoading] = useState(false);

  // Newly created key (shown once)
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState<ApiKeyResponse | null>(null);
  const [editName, setEditName] = useState('');
  const [editCapability, setEditCapability] = useState<ApiKeyCapability>(DEFAULT_API_KEY_CAPABILITY);
  // A promotion grants authority the key did not have, so it passes through a confirmation naming
  // the key and what it will be able to do. Held as a step on the same dialog rather than a second
  // one: one dialog with two faces cannot be left half-open.
  const [editStep, setEditStep] = useState<'form' | 'confirm'>('form');
  const [editLoading, setEditLoading] = useState(false);

  // Delete dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteKey, setDeleteKey] = useState<ApiKeyResponse | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const headers = useCallback(
    () => ({
      Authorization: `Bearer ${authToken}`,
      'Content-Type': 'application/json',
    }),
    [authToken],
  );

  const fetchKeys = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchJson<ApiKeyResponse[]>('/api/keys', { headers: headers() });
      setKeys(data ?? []);
    } catch {
      setError('Failed to load API keys');
    } finally {
      setLoading(false);
    }
  }, [headers]);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  /**
   * Reset the form whenever the dialog closes. Without this a cancelled dialog reopens holding the
   * previous selection, so a user who once picked scopes could mint a scope-limited key believing
   * it has full access.
   */
  const handleCreateOpenChange = (open: boolean) => {
    setCreateOpen(open);

    if (!open) {
      setCreateName('');
      setCreateExpiresAt(undefined);
      setCreateScopes([]);
      // Reset the level too — a 'full' chosen for one key must not silently carry into the next.
      setCreateCapability(DEFAULT_API_KEY_CAPABILITY);
    }
  };

  const toggleCreateScope = (scope: string) => {
    setCreateScopes((current) =>
      current.includes(scope) ? current.filter((s) => s !== scope) : [...current, scope],
    );
  };

  // The one scope combination that looks valid and is not: the server confines a scope-limited key
  // off the GraphQL data plane, and gates the native intent tools behind `intents`. So `mcp` on its
  // own leaves the tool list empty. An unscoped key is unaffected — it is not scope-limited.
  const mcpWithoutIntents =
    createScopes.includes(API_KEY_SCOPE_MCP) && !createScopes.includes(API_KEY_SCOPE_INTENTS);

  // Capability is enforced on the routes that declare a scope — which is every route a scope-limited
  // key can reach. An unscoped key is not scope-limited, so it also reaches GraphQL and bulk ingest,
  // where nothing checks its capability. Read-only therefore means less than it says for this one
  // combination, and the honest place to say so is here, before the key exists.
  const readWithoutScopes = createCapability === API_KEY_CAPABILITY_READ && createScopes.length === 0;

  const handleCreate = async () => {
    if (!createName.trim()) {
      return;
    }

    try {
      setCreateLoading(true);
      const body: Record<string, unknown> = { name: createName.trim() };
      if (createExpiresAt) {
        body.expires_at = createExpiresAt.toISOString();
      }

      // Omitted when empty so the key keeps the grandfathered full-access meaning.
      if (createScopes.length > 0) {
        body.scopes = createScopes;
      }

      // Always sent, unlike scopes: there is no "unset" reading of a capability, and stating it
      // makes the key's authority a decision rather than a default nobody saw.
      body.capability = createCapability;

      const data = await fetchJson<CreateApiKeyResponse>('/api/keys', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });

      setRevealedKey(data?.key ?? null);
      // Closing programmatically does not fire the dialog's onOpenChange, so route through the same
      // handler rather than repeating the field resets, which would otherwise have to stay in sync.
      handleCreateOpenChange(false);
      await fetchKeys();
    } catch {
      setError('Failed to create API key');
    } finally {
      setCreateLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!editKey || !editName.trim()) {
      return;
    }

    // Confirm before granting authority the key did not have. A demotion needs no confirmation —
    // it only ever removes authority, and making that harder would discourage tightening a key.
    if (editStep === 'form' && isApiKeyCapabilityPromotion(capabilityOf(editKey), editCapability)) {
      setEditStep('confirm');

      return;
    }

    try {
      setEditLoading(true);

      // A Hub-managed key's name is not the user's to change (the Hub revokes by name, so a rename
      // would strand the credential) — send only what they may change. Its capability IS theirs:
      // narrowing it refuses operations without breaking the connection.
      const body: Record<string, unknown> = { capability: editCapability };

      if (!isHubManagedKey(editKey)) {
        body.name = editName.trim();
      }

      await fetchJson<ApiKeyResponse>(`/api/keys/${editKey.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify(body),
      });
      closeEdit();
      await fetchKeys();
    } catch {
      setError('Failed to update API key');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteKey) {
      return;
    }

    try {
      setDeleteLoading(true);
      await fetchJson(`/api/keys/${deleteKey.id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      setDeleteOpen(false);
      setDeleteKey(null);
      await fetchKeys();
    } catch {
      setError('Failed to delete API key');
    } finally {
      setDeleteLoading(false);
    }
  };

  const openEdit = (key: ApiKeyResponse) => {
    setEditKey(key);
    setEditName(key.name);
    setEditCapability(capabilityOf(key));
    setEditStep('form');
    setEditOpen(true);
  };

  const closeEdit = () => {
    setEditOpen(false);
    setEditKey(null);
    setEditName('');
    setEditStep('form');
  };

  const openDelete = (key: ApiKeyResponse) => {
    setDeleteKey(key);
    setDeleteOpen(true);
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const formatDate = (date: string | null) => {
    if (!date) {
      return null;
    }

    return new Date(date).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const isExpired = (expiresAt: string | null) => {
    if (!expiresAt) {
      return false;
    }

    return new Date(expiresAt) < new Date();
  };

  return (
    <>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">API Keys</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Create keys to grant other applications access to your account.
          </p>
        </div>
        {/* Icon-only trigger: without an explicit label it reaches assistive tech as an unnamed button. */}
        <IconButton
          variant="outline"
          label={t('SETTINGS_API_KEY_CREATE')}
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
        </IconButton>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Revealed key banner */}
      {revealedKey && (
        <Card className="mb-4 border-green-200 dark:border-green-800 relative">
          <IconButton
            variant="ghost"
            label={t('SETTINGS_API_KEY_DISMISS_BANNER')}
            className="absolute top-3 right-3 h-6 w-6"
            onClick={() => {
              setRevealedKey(null);
              setCopied(false);
            }}
          >
            <X className="h-3 w-3" />
          </IconButton>
          <Card.Content className="space-y-4">
            <p className="text-sm font-medium text-green-700 dark:text-green-400 pr-8">
              Your new API key has been created.
            </p>
            <div className="flex items-center gap-1.5 p-1.5 border shadow-xs rounded-md bg-background">
              <Input
                readOnly
                value={revealedKey}
                className="!flex-1 !border-0 !ring-0 !shadow-none !bg-transparent !p-0 !ml-1 !h-auto !rounded-none font-mono text-sm focus-visible:!ring-0 focus-visible:!border-transparent"
              />
              <IconButton
                variant="ghost"
                size="sm"
                label={t('SETTINGS_API_KEY_COPY')}
                onClick={() => copyToClipboard(revealedKey)}
                className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <ClipboardCopy className="h-4 w-4" />
                )}
              </IconButton>
            </div>
            <p className="text-xs text-muted-foreground">The key value won't be shown again.</p>
          </Card.Content>
        </Card>
      )}

      {/* Key list */}
      {loading ? (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">Loading…</div>
      ) : keys.length === 0 ? (
        <Card>
          <Card.Content className="flex flex-col items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">No API keys created yet.</p>
          </Card.Content>
        </Card>
      ) : (
        <div className="space-y-3">
          {keys.map((key) => (
            <Card key={key.id}>
              <Card.Content className="flex items-center justify-between">
                <div className="min-w-0 flex-1 space-y-4">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{key.name}</span>
                    {isExpired(key.expires_at) && (
                      <Badge variant="destructive" className="text-xs">
                        Expired
                      </Badge>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {isHubManagedKey(key) ? (
                      <Badge
                        variant="outline"
                        className="border-emerald-500/30 bg-emerald-500/10 text-xs text-emerald-600 dark:text-emerald-400"
                      >
                        <Lock />
                        Managed by Companion Hub
                      </Badge>
                    ) : key.scopes.length === 0 ? (
                      <Badge variant="outline" className="text-xs">
                        <KeyRound />
                        Full access
                      </Badge>
                    ) : (
                      key.scopes.map((scope) => (
                        <Badge key={scope} variant="outline" className="text-xs">
                          {scope}
                        </Badge>
                      ))
                    )}
                    {/* Shown for every key, including Hub-managed and full-surface ones: the scope
                        badges say where a key reaches, and without this the row never says whether
                        it can delete what it finds there. */}
                    <Badge
                      variant="outline"
                      className={`text-xs ${CAPABILITY_BADGE_CLASS[capabilityOf(key)]}`}
                    >
                      {CAPABILITY_LABELS[capabilityOf(key)]}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      Key: <code className="font-mono">{key.prefix}…</code>
                    </span>
                    <span>Created {formatDate(key.created_at)}</span>
                    {key.expires_at && <span>Expires {formatDate(key.expires_at)}</span>}
                    {key.last_used_at && <span>Last used {formatDate(key.last_used_at)}</span>}
                  </div>
                </div>
                <div className="ml-4 flex items-center gap-1">
                  <IconButton
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => openEdit(key)}
                    label={t('SETTINGS_API_KEY_EDIT', { name: key.name })}
                    tooltip={isHubManagedKey(key) ? t('SETTINGS_API_KEY_HUB_MANAGED') : undefined}
                  >
                    <Pencil className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    className="h-8 w-8 text-red-600 hover:text-red-700"
                    onClick={() => openDelete(key)}
                    label={t('SETTINGS_API_KEY_DELETE', { name: key.name })}
                  >
                    <Trash className="h-4 w-4" />
                  </IconButton>
                </div>
              </Card.Content>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={handleCreateOpenChange}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Create API Key</Dialog.Title>
          </Dialog.Header>
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="apiKeyName">Name</Label>
              <Input
                id="apiKeyName"
                placeholder="e.g. OpenClaw access key"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
            </div>
            <div className="grid gap-2">
              <Label>Expiration (optional)</Label>
              <Popover>
                <Popover.Trigger asChild>
                  <Button
                    variant="outline"
                    className={`w-full justify-start text-left font-normal ${
                      !createExpiresAt ? 'text-muted-foreground' : ''
                    }`}
                  >
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {createExpiresAt
                      ? createExpiresAt.toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'long',
                          day: 'numeric',
                        })
                      : 'Pick a date'}
                  </Button>
                </Popover.Trigger>
                <Popover.Content className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={createExpiresAt}
                    onSelect={setCreateExpiresAt}
                    disabled={{ before: new Date() }}
                    autoFocus
                  />
                </Popover.Content>
              </Popover>
            </div>
            <div className="grid gap-2">
              <Label>Access</Label>
              <div className="space-y-2 rounded-md border p-3">
                {SCOPE_OPTIONS.map((scope) => (
                  // The description is wired up with aria-describedby rather than folded into the
                  // label: an aria-label naming the checkbox would suppress it entirely, leaving
                  // assistive tech with "MCP" and no statement of what it unlocks.
                  <div key={scope.value} className="flex items-start gap-3">
                    <Checkbox
                      id={`apiKeyScope-${scope.value}`}
                      aria-describedby={`apiKeyScope-${scope.value}-description`}
                      checked={createScopes.includes(scope.value)}
                      onCheckedChange={() => toggleCreateScope(scope.value)}
                    />
                    <div className="grid gap-0.5 text-sm leading-none">
                      <Label htmlFor={`apiKeyScope-${scope.value}`} className="cursor-pointer font-medium">
                        {scope.label}
                      </Label>
                      <span
                        id={`apiKeyScope-${scope.value}-description`}
                        className="text-muted-foreground text-xs"
                      >
                        {scope.description}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              {/* Both lines below restate the consequence of the current selection and change as
                  boxes are ticked, so they have to be a live region: otherwise the amber warning is
                  visible-only, and a screen-reader user picks the broken combination in silence —
                  the exact outcome the warning exists to prevent. */}
              <div role="status" className="grid gap-2">
                <p className="text-muted-foreground text-xs">
                  {createScopes.length === 0
                    ? 'No selection grants full access — the key can reach every endpoint your account can.'
                    : 'The key is limited to the selected areas and is refused everywhere else, including bulk ingest and GraphQL.'}
                </p>
                {/* MCP without Intents authenticates and opens a session, then advertises zero tools
                    — which agents report as "this server has no tools" rather than as a permissions
                    problem. Say so here, at the point of choice, rather than leaving the user to
                    debug an empty tool list. */}
                {mcpWithoutIntents ? (
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                    MCP alone advertises no tools. Add Intents, or leave every box unchecked for full access.
                  </p>
                ) : null}
                {readWithoutScopes ? (
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                    Read-only is enforced on the areas selected above. A key with no areas selected can still
                    reach GraphQL and bulk ingest — pick the areas it needs to confine it.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="grid gap-2">
              <Label>What this key can do</Label>
              <RadioGroup
                value={createCapability}
                onValueChange={(value) => setCreateCapability(value as ApiKeyCapability)}
                className="space-y-2 rounded-md border p-3"
              >
                {CAPABILITY_OPTIONS.map((option) => (
                  // Same aria-describedby treatment as the scope checkboxes: an aria-label naming
                  // the radio would suppress the description, leaving assistive tech with
                  // "Full access" and no statement of what that permits.
                  <div key={option.value} className="flex items-start gap-3">
                    <RadioGroup.Item
                      id={`apiKeyCapability-${option.value}`}
                      value={option.value}
                      aria-describedby={`apiKeyCapability-${option.value}-description`}
                    />
                    <div className="grid gap-0.5 text-sm leading-none">
                      <Label
                        htmlFor={`apiKeyCapability-${option.value}`}
                        className="cursor-pointer font-medium"
                      >
                        {option.label}
                      </Label>
                      <span
                        id={`apiKeyCapability-${option.value}-description`}
                        className="text-muted-foreground text-xs"
                      >
                        {option.description}
                      </span>
                    </div>
                  </div>
                ))}
              </RadioGroup>
            </div>
          </div>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => handleCreateOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!createName.trim() || createLoading}>
              {createLoading ? 'Creating…' : 'Create'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Edit dialog: rename and/or change what the key may do, with a confirmation before a
          promotion. Open for Hub-managed keys too — their name is not the user's to change, but
          what they may do with the user's own data is. */}
      <Dialog open={editOpen} onOpenChange={(open) => (open ? setEditOpen(true) : closeEdit())}>
        <Dialog.Content>
          {editStep === 'form' ? (
            <>
              <Dialog.Header>
                <Dialog.Title>Edit API Key</Dialog.Title>
                <Dialog.Description>
                  The key value does not change, so anything using it keeps working — with the access you
                  choose here.
                </Dialog.Description>
              </Dialog.Header>
              <div className="space-y-4 py-2">
                <div className="grid gap-2">
                  <Label htmlFor="editApiKeyName">Name</Label>
                  <Input
                    id="editApiKeyName"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleUpdate()}
                    disabled={editKey ? isHubManagedKey(editKey) : false}
                    aria-describedby={
                      editKey && isHubManagedKey(editKey) ? 'editApiKeyName-managed' : undefined
                    }
                  />
                  {editKey && isHubManagedKey(editKey) && (
                    <span id="editApiKeyName-managed" className="text-muted-foreground text-xs">
                      Companion Hub revokes this key by name, so renaming it would strand the connection.
                    </span>
                  )}
                </div>
                <div className="grid gap-2">
                  <Label>What this key can do</Label>
                  <RadioGroup
                    value={editCapability}
                    onValueChange={(value) => setEditCapability(value as ApiKeyCapability)}
                    className="space-y-2 rounded-md border p-3"
                  >
                    {CAPABILITY_OPTIONS.map((option) => (
                      // Same aria-describedby treatment as the scope checkboxes: an aria-label naming
                      // the radio would suppress the description, leaving assistive tech with
                      // "Full access" and no statement of what that permits.
                      <div key={option.value} className="flex items-start gap-3">
                        <RadioGroup.Item
                          id={`editApiKeyCapability-${option.value}`}
                          value={option.value}
                          aria-describedby={`editApiKeyCapability-${option.value}-description`}
                        />
                        <div className="grid gap-0.5 text-sm leading-none">
                          <Label
                            htmlFor={`editApiKeyCapability-${option.value}`}
                            className="cursor-pointer font-medium"
                          >
                            {option.label}
                          </Label>
                          <span
                            id={`editApiKeyCapability-${option.value}-description`}
                            className="text-muted-foreground text-xs"
                          >
                            {option.description}
                          </span>
                        </div>
                      </div>
                    ))}
                  </RadioGroup>
                </div>
              </div>
              <Dialog.Footer>
                <Button variant="outline" onClick={closeEdit}>
                  Cancel
                </Button>
                <Button onClick={handleUpdate} disabled={!editName.trim() || editLoading}>
                  {editLoading ? 'Saving…' : 'Save'}
                </Button>
              </Dialog.Footer>
            </>
          ) : (
            <>
              <Dialog.Header>
                {/* The key is named in the title: someone with several keys must not be able to
                    widen the wrong one because the dialog only said "this key". */}
                <Dialog.Title>
                  {editCapability === API_KEY_CAPABILITY_FULL
                    ? `Let “${editKey?.name}” delete your data?`
                    : `Let “${editKey?.name}” change your data?`}
                </Dialog.Title>
                <Dialog.Description>
                  {editCapability === API_KEY_CAPABILITY_FULL
                    ? 'Anything holding this key will be able to delete memories and other stored data. Deletions cannot be undone.'
                    : 'Anything holding this key will be able to record new memories and update existing ones. It will still be refused deletions.'}
                </Dialog.Description>
              </Dialog.Header>
              <Dialog.Footer>
                <Button variant="outline" onClick={() => setEditStep('form')}>
                  Back
                </Button>
                <Button
                  variant={editCapability === API_KEY_CAPABILITY_FULL ? 'destructive' : 'default'}
                  onClick={handleUpdate}
                  disabled={editLoading}
                >
                  {editLoading ? 'Saving…' : 'Grant access'}
                </Button>
              </Dialog.Footer>
            </>
          )}
        </Dialog.Content>
      </Dialog>

      {/* Delete confirmation dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Delete API Key</Dialog.Title>
            <Dialog.Description>
              Are you sure you want to delete the <strong>{deleteKey?.name}</strong> key? Any integrations
              using this key will stop working. This action cannot be undone.
            </Dialog.Description>
          </Dialog.Header>
          {deleteKey && isHubManagedKey(deleteKey) && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300">
              This key is managed by Companion Hub for a connected app. Deleting it here will break that app's
              memory connection — to disconnect cleanly, use <strong>Disconnect Memory</strong> on the app's
              page in Hub instead.
            </div>
          )}
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleteLoading}>
              {deleteLoading ? 'Deleting…' : 'Delete'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
