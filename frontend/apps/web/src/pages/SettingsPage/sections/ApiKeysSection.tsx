import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';
import { Badge, Button, Calendar, Card, Dialog, Input, Label, Popover } from '@ci/shadcn';
import { CalendarIcon, Check, ClipboardCopy, Pencil, Plus, Trash, X } from '@ci/shadcn/icons';

import { useAuth } from '@/hooks';

interface ApiKeyResponse {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateApiKeyResponse extends ApiKeyResponse {
  key: string;
}

export function ApiKeysSection() {
  const [{ authToken }] = useAuth();

  const [keys, setKeys] = useState<ApiKeyResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createExpiresAt, setCreateExpiresAt] = useState<Date | undefined>(undefined);
  const [createLoading, setCreateLoading] = useState(false);

  // Newly created key (shown once)
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Edit dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editKey, setEditKey] = useState<ApiKeyResponse | null>(null);
  const [editName, setEditName] = useState('');
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

      const data = await fetchJson<CreateApiKeyResponse>('/api/keys', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });

      setRevealedKey(data?.key ?? null);
      setCreateOpen(false);
      setCreateName('');
      setCreateExpiresAt(undefined);
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

    try {
      setEditLoading(true);
      await fetchJson<ApiKeyResponse>(`/api/keys/${editKey.id}`, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ name: editName.trim() }),
      });
      setEditOpen(false);
      setEditKey(null);
      setEditName('');
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
    setEditOpen(true);
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
        <Button variant="outline" size="icon" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Revealed key banner */}
      {revealedKey && (
        <Card className="mb-4 border-green-200 dark:border-green-800 relative">
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-3 right-3 h-6 w-6"
            onClick={() => {
              setRevealedKey(null);
              setCopied(false);
            }}
          >
            <X className="h-3 w-3" />
          </Button>
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
              <Button
                variant="ghost"
                size="sm"
                onClick={() => copyToClipboard(revealedKey)}
                className="cursor-pointer h-8 w-8 p-0 active:scale-90 transition-transform duration-200 ease-out will-change-transform"
              >
                {copied ? (
                  <Check className="h-4 w-4 text-green-600" />
                ) : (
                  <ClipboardCopy className="h-4 w-4" />
                )}
              </Button>
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
                  <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(key)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-red-600 hover:text-red-700"
                    onClick={() => openDelete(key)}
                  >
                    <Trash className="h-4 w-4" />
                  </Button>
                </div>
              </Card.Content>
            </Card>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
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
          </div>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!createName.trim() || createLoading}>
              {createLoading ? 'Creating…' : 'Create'}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Edit API Key</Dialog.Title>
            <Dialog.Description>Update the name of your API key.</Dialog.Description>
          </Dialog.Header>
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="editApiKeyName">Name</Label>
              <Input
                id="editApiKeyName"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleUpdate()}
              />
            </div>
          </div>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={!editName.trim() || editLoading}>
              {editLoading ? 'Saving…' : 'Save'}
            </Button>
          </Dialog.Footer>
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
