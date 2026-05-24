import { useState, useEffect } from 'react';

import { gql, useQuery, useMutation } from '@apollo/client';
import { Button, Card, Dialog, Input, Label } from '@ci/shadcn';
import { Eye, EyeOff, Save, Trash } from '@ci/shadcn/icons';

import type { Provider } from '@/pages/ConnectionsPage/ConnectionsPage.tsx';

export interface ProviderKey {
  readonly id: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly providerId: string;
  readonly userId: string;
}

const GET_PROVIDERS = gql(`
  query GetProviders {
    providers {
      edges {
        cursor
        node {
          id
          name
          description
          logoUrl
          authType
          providerKeys {
            id
            clientId
            clientSecret
          }
        }
      }
    }
  }
`);

const CREATE_PROVIDER_KEY = gql(`
  mutation CreateProviderKey($input: CreateProviderKeyInput!) {
    createProviderKey(input: $input) {
      id
      providerId
      clientId
      clientSecret
      userId
    }
  }
`);

const UPDATE_PROVIDER_KEY = gql(`
  mutation UpdateProviderKey($id: ID!, $input: UpdateProviderKeyInput!) {
    updateProviderKey(id: $id, input: $input) {
      id
      clientId
      clientSecret
    }
  }
`);

const DELETE_PROVIDER_KEY = gql(`
  mutation DeleteProviderKey($id: ID!) {
    deleteProviderKey(id: $id)
  }
`);

type OAuthProvider = 'google' | 'microsoft' | 'facebook' | 'spotify';

interface OAuthState {
  oauth: Record<
    string,
    {
      providerKeyId?: string;
      clientId: string;
      clientSecret: string;
    }
  >;
}

export function OAuthSection() {
  const [settings, setSettings] = useState<OAuthState>({
    oauth: {
      google: { clientId: '', clientSecret: '' },
      microsoft: { clientId: '', clientSecret: '' },
      facebook: { clientId: '', clientSecret: '' },
      spotify: { clientId: '', clientSecret: '' },
    },
  });

  const [showKeys, setShowKeys] = useState<Record<string, boolean>>({
    googleClientId: false,
    googleClientSecret: false,
    microsoftClientId: false,
    microsoftClientSecret: false,
    facebookClientId: false,
    facebookClientSecret: false,
    spotifyClientId: false,
    spotifyClientSecret: false,
  });

  const [originalValues, setOriginalValues] = useState<
    Record<string, { clientId: string; clientSecret: string }>
  >({
    google: { clientId: '', clientSecret: '' },
    microsoft: { clientId: '', clientSecret: '' },
    facebook: { clientId: '', clientSecret: '' },
    spotify: { clientId: '', clientSecret: '' },
  });

  const [validationErrors, setValidationErrors] = useState<
    Record<string, { clientId?: string; clientSecret?: string }>
  >({
    google: {},
    microsoft: {},
    facebook: {},
    spotify: {},
  });

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [providerToDelete, setProviderToDelete] = useState<OAuthProvider | null>(null);

  const { data: providersData } = useQuery(GET_PROVIDERS);
  const [createProviderKey] = useMutation(CREATE_PROVIDER_KEY);
  const [updateProviderKey] = useMutation(UPDATE_PROVIDER_KEY);
  const [deleteProviderKey] = useMutation(DELETE_PROVIDER_KEY);

  useEffect(() => {
    if (!providersData) {
      return;
    }

    const providers: Provider[] = providersData.providers.edges.map((edge: { node: Provider }) => edge.node);

    const newOriginalValues: Record<string, { clientId: string; clientSecret: string }> = {
      google: { clientId: '', clientSecret: '' },
      microsoft: { clientId: '', clientSecret: '' },
      facebook: { clientId: '', clientSecret: '' },
      spotify: { clientId: '', clientSecret: '' },
    };

    setSettings((prev) => {
      const newSettings = { ...prev };

      providers.forEach((provider) => {
        const providerName = provider.name?.toLowerCase();
        if (
          providerName &&
          provider.providerKeys &&
          newSettings.oauth[providerName as keyof typeof newSettings.oauth]
        ) {
          newSettings.oauth[providerName as keyof typeof newSettings.oauth] = {
            providerKeyId: provider.providerKeys.id,
            clientId: provider.providerKeys.clientId,
            clientSecret: provider.providerKeys.clientSecret,
          };
          newOriginalValues[providerName] = {
            clientId: provider.providerKeys.clientId,
            clientSecret: provider.providerKeys.clientSecret,
          };
        }
      });

      return newSettings;
    });

    setOriginalValues(newOriginalValues);
  }, [providersData]);

  const updateSetting = (key: string, value: string) => {
    let updatedSettings: OAuthState = settings;

    setSettings((prev) => {
      const keys = key.split('.');
      const updated = { ...prev };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let current: any = updated;

      for (let i = 0; i < keys.length - 1; i++) {
        current[keys[i]] = { ...current[keys[i]] };
        current = current[keys[i]];
      }

      current[keys[keys.length - 1]] = value;
      updatedSettings = updated;

      return updated;
    });

    if (key.startsWith('oauth.')) {
      const parts = key.split('.');
      if (parts.length === 3) {
        const provider = parts[1] as OAuthProvider;
        const { clientId, clientSecret, providerKeyId } = updatedSettings.oauth[provider];
        const errors: { clientId?: string; clientSecret?: string } = {};

        const hasClientId = clientId && clientId.trim().length > 0;
        const hasClientSecret = clientSecret && clientSecret.trim().length > 0;

        if (providerKeyId || hasClientId || hasClientSecret) {
          if (!hasClientId) {
            errors.clientId = 'Client ID is required';
          }

          if (!hasClientSecret) {
            errors.clientSecret = 'Client Secret is required';
          }
        }

        setValidationErrors((prev) => ({ ...prev, [provider]: errors }));
      }
    }
  };

  const toggleKeyVisibility = (keyName: string) => {
    setShowKeys((prev) => ({ ...prev, [keyName]: !prev[keyName] }));
  };

  const hasProviderChanges = (provider: OAuthProvider): boolean => {
    const current = settings.oauth[provider];
    const original = originalValues[provider];
    const { providerKeyId } = current;

    if (!providerKeyId) {
      return current.clientId?.trim().length > 0 && current.clientSecret?.trim().length > 0;
    }

    return current.clientId !== original.clientId || current.clientSecret !== original.clientSecret;
  };

  const validateOAuthFields = (provider: string): boolean => {
    if (!settings.oauth[provider]) {
      return true;
    }

    const { clientId, clientSecret, providerKeyId } = settings.oauth[provider];
    const errors: { clientId?: string; clientSecret?: string } = {};
    let isValid = true;

    const hasClientId = clientId && clientId.trim().length > 0;
    const hasClientSecret = clientSecret && clientSecret.trim().length > 0;

    if (providerKeyId || hasClientId || hasClientSecret) {
      if (!hasClientId) {
        errors.clientId = 'Client ID is required';
        isValid = false;
      }

      if (!hasClientSecret) {
        errors.clientSecret = 'Client Secret is required';
        isValid = false;
      }
    }

    setValidationErrors((prev) => ({ ...prev, [provider]: errors }));

    return isValid;
  };

  const handleSaveOAuthField = async (provider: OAuthProvider) => {
    if (!validateOAuthFields(provider)) {
      return;
    }

    const { providerKeyId, clientId, clientSecret } = settings.oauth[provider];

    try {
      if (!providerKeyId) {
        if (!providersData) {
          return;
        }

        const providers: Provider[] = providersData.providers.edges.map(
          (edge: { node: Provider }) => edge.node,
        );
        const providerEntity = providers.find((p) => p.name?.toLowerCase() === provider);

        if (!providerEntity) {
          console.error('Provider not found:', provider);

          return;
        }

        const result = await createProviderKey({
          variables: { input: { providerId: providerEntity.id, clientId, clientSecret } },
        });

        setSettings((prev) => ({
          ...prev,
          oauth: {
            ...prev.oauth,
            [provider]: { ...prev.oauth[provider], providerKeyId: result.data?.createProviderKey.id },
          },
        }));
      } else {
        await updateProviderKey({ variables: { id: providerKeyId, input: { clientId, clientSecret } } });
      }

      setOriginalValues((prev) => ({ ...prev, [provider]: { clientId, clientSecret } }));
      setValidationErrors((prev) => ({ ...prev, [provider]: {} }));
    } catch (error) {
      console.error('Failed to save provider key:', error);
    }
  };

  const handleDeleteOAuthKey = async (provider: OAuthProvider) => {
    const { providerKeyId } = settings.oauth[provider];
    if (!providerKeyId) {
      return;
    }

    try {
      await deleteProviderKey({ variables: { id: providerKeyId } });

      setSettings((prev) => ({
        ...prev,
        oauth: {
          ...prev.oauth,
          [provider]: { providerKeyId: undefined, clientId: '', clientSecret: '' },
        },
      }));
      setOriginalValues((prev) => ({ ...prev, [provider]: { clientId: '', clientSecret: '' } }));
      setValidationErrors((prev) => ({ ...prev, [provider]: {} }));
      setDeleteModalOpen(false);
      setProviderToDelete(null);
    } catch (error) {
      console.error('Failed to delete provider key:', error);
    }
  };

  const openDeleteModal = (provider: OAuthProvider) => {
    setProviderToDelete(provider);
    setDeleteModalOpen(true);
  };

  const renderProvider = (provider: OAuthProvider, label: string) => {
    const providerData = settings.oauth[provider];
    const errors = validationErrors[provider];

    return (
      <Card key={provider}>
        <Card.Header className="flex flex-row items-center justify-between">
          <Card.Title className="text-base font-semibold">{label}</Card.Title>
          <div className="flex gap-2">
            {providerData.providerKeyId && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => openDeleteModal(provider)}
                className="h-8 w-8 text-red-600 hover:text-red-700"
              >
                <Trash className="h-4 w-4" />
              </Button>
            )}
            {hasProviderChanges(provider) && (
              <Button
                variant="outline"
                size="icon"
                onClick={() => handleSaveOAuthField(provider)}
                className="h-8 w-8 text-green-600 hover:text-green-700"
                disabled={
                  providerData.providerKeyId != null &&
                  (!providerData.clientId?.trim() || !providerData.clientSecret?.trim())
                }
              >
                <Save className="h-4 w-4" />
              </Button>
            )}
          </div>
        </Card.Header>
        <Card.Content className="space-y-3">
          <div className="grid gap-2">
            <Label htmlFor={`${provider}ClientId`}>Client ID</Label>
            <div className="flex gap-2">
              <Input
                id={`${provider}ClientId`}
                type={showKeys[`${provider}ClientId`] ? 'text' : 'password'}
                value={providerData.clientId}
                onChange={(e) => updateSetting(`oauth.${provider}.clientId`, e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => toggleKeyVisibility(`${provider}ClientId`)}
              >
                {showKeys[`${provider}ClientId`] ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            {errors.clientId &&
              (providerData.providerKeyId || providerData.clientSecret?.trim().length > 0) && (
                <p className="text-sm text-red-600">{errors.clientId}</p>
              )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${provider}ClientSecret`}>Client Secret</Label>
            <div className="flex gap-2">
              <Input
                id={`${provider}ClientSecret`}
                type={showKeys[`${provider}ClientSecret`] ? 'text' : 'password'}
                value={providerData.clientSecret}
                onChange={(e) => updateSetting(`oauth.${provider}.clientSecret`, e.target.value)}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => toggleKeyVisibility(`${provider}ClientSecret`)}
              >
                {showKeys[`${provider}ClientSecret`] ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </Button>
            </div>
            {errors.clientSecret &&
              (providerData.providerKeyId || providerData.clientId?.trim().length > 0) && (
                <p className="text-sm text-red-600">{errors.clientSecret}</p>
              )}
          </div>
        </Card.Content>
      </Card>
    );
  };

  return (
    <>
      <div className="mb-6">
        <h2 className="text-xl font-semibold">OAuth Credentials</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Use your own OAuth app credentials for connecting to external providers.
        </p>
      </div>

      <div className="space-y-4">
        {renderProvider('google', 'Google')}
        {renderProvider('microsoft', 'Microsoft')}
        {renderProvider('facebook', 'Facebook')}
        {renderProvider('spotify', 'Spotify')}
      </div>

      <Dialog open={deleteModalOpen} onOpenChange={setDeleteModalOpen}>
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>Delete OAuth Keys</Dialog.Title>
            <Dialog.Description>
              Are you sure you want to delete the OAuth keys for {providerToDelete}? This action cannot be
              undone.
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button variant="outline" onClick={() => setDeleteModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => providerToDelete && handleDeleteOAuthKey(providerToDelete)}
            >
              Delete
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
