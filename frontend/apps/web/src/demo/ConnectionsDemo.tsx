import { useState } from 'react';
import { Button, Dialog, Input, Label, Select, Collapsible } from '@ci/shadcn';
import { HelpCircle, ChevronDown, ChevronUp } from '@ci/shadcn/icons';
import { PlatformInstructions, type PlatformKey } from '@/components/PlatformInstructions';

// Mock providers for demo
const mockProviders = [
  { id: '1', name: 'Google' },
  { id: '2', name: 'Meta' },
  { id: '3', name: 'Microsoft' },
  { id: '4', name: 'Spotify' },
  { id: '5', name: 'Apple' },
];

// Mock connection for edit demo
const mockConnection = {
  id: 'demo-1',
  name: 'Demo Google Connection',
  active: true,
  clientid: 'demo-client-id',
  clientkey: '',
  clientsecret: 'demo-client-secret',
  schedule: 'daily',
  accessToken: null,
  refreshToken: null,
  tokenExpiry: null,
  provider: { id: '1', name: 'Google' },
};

export function ConnectionsDemo() {
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [createFormData, setCreateFormData] = useState({
    name: '',
    providerId: '1',
  });
  const [editFormData, setEditFormData] = useState({
    name: mockConnection.name,
    clientid: mockConnection.clientid || '',
    clientkey: mockConnection.clientkey || '',
    clientsecret: mockConnection.clientsecret || '',
    schedule: mockConnection.schedule || 'daily',
  });
  const [showInstructionsInCreate, setShowInstructionsInCreate] = useState(true);
  const [showInstructionsInEdit, setShowInstructionsInEdit] = useState(true);

  // Helper function to get platform key from provider name
  const getPlatformKey = (providerName: string | null): PlatformKey | null => {
    if (!providerName) {
      return null;
    }

    const normalizedName = providerName.toLowerCase();

    if (normalizedName.includes('google')) {
      return 'google';
    }
    if (normalizedName.includes('facebook') || normalizedName.includes('meta')) {
      return 'meta';
    }
    if (normalizedName.includes('microsoft') || normalizedName.includes('azure')) {
      return 'microsoft';
    }
    if (normalizedName.includes('spotify')) {
      return 'spotify';
    }
    if (normalizedName.includes('apple')) {
      return 'apple';
    }

    return null;
  };

  // Get platform instructions component
  const getPlatformInstructions = (providerName: string | null) => {
    const platformKey = getPlatformKey(providerName);
    if (!platformKey) {
      return null;
    }

    const InstructionComponent = PlatformInstructions[platformKey];
    return InstructionComponent ? <InstructionComponent /> : null;
  };

  return (
    <div className="p-8 space-y-6">
      <h1 className="text-3xl font-bold">Connections Demo - Platform API Instructions</h1>
      
      <div className="space-y-4">
        <p className="text-muted-foreground">
          This demo showcases the enhanced connection modals with platform-specific API key setup instructions.
        </p>
        
        <div className="flex gap-4">
          <Button onClick={() => setShowCreateModal(true)}>
            Show Create Connection Modal
          </Button>
          <Button variant="outline" onClick={() => setShowEditModal(true)}>
            Show Edit Connection Modal
          </Button>
        </div>

        <div className="space-y-2">
          <h3 className="text-lg font-semibold">Platform Instruction Components:</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {mockProviders.map((provider) => {
              const instructions = getPlatformInstructions(provider.name);
              return instructions ? (
                <div key={provider.id} className="border rounded-lg p-4">
                  <h4 className="font-medium mb-2">{provider.name} Instructions</h4>
                  <div className="max-h-48 overflow-y-auto">
                    {instructions}
                  </div>
                </div>
              ) : null;
            })}
          </div>
        </div>
      </div>

      {/* Create Connection Modal */}
      <Dialog open={showCreateModal} onOpenChange={setShowCreateModal}>
        <Dialog.Content className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
          <Dialog.Header>
            <Dialog.Title>Create Connection</Dialog.Title>
            <Dialog.Description>Create a new connection to a provider.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="create-name">Connection Name</Label>
              <Input
                id="create-name"
                placeholder="My Google Connection"
                value={createFormData.name}
                onChange={(e) => setCreateFormData({ ...createFormData, name: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="create-provider">Provider</Label>
              <Select
                value={createFormData.providerId}
                onValueChange={(value) => setCreateFormData({ ...createFormData, providerId: value })}
              >
                <Select.Trigger id="create-provider">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {mockProviders.map((provider) => (
                    <Select.Item key={provider.id} value={provider.id}>
                      {provider.name}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>

            {/* Platform Instructions */}
            {createFormData.providerId &&
              (() => {
                const selectedProvider = mockProviders.find((p) => p.id === createFormData.providerId);
                const instructions = selectedProvider ? getPlatformInstructions(selectedProvider.name) : null;

                if (!instructions) {
                  return null;
                }

                return (
                  <Collapsible open={showInstructionsInCreate} onOpenChange={setShowInstructionsInCreate}>
                    <div className="flex items-center gap-2">
                      <Collapsible.Trigger asChild>
                        <Button variant="outline" size="sm" className="justify-start">
                          <HelpCircle className="h-4 w-4 mr-2" />
                          API Setup Instructions
                          {showInstructionsInCreate ? (
                            <ChevronUp className="h-4 w-4 ml-2" />
                          ) : (
                            <ChevronDown className="h-4 w-4 ml-2" />
                          )}
                        </Button>
                      </Collapsible.Trigger>
                    </div>
                    <Collapsible.Content className="mt-2">{instructions}</Collapsible.Content>
                  </Collapsible>
                );
              })()}
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowCreateModal(false)}>
              Cancel
            </Button>
            <Button disabled={!createFormData.name || !createFormData.providerId}>
              Create (Demo)
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>

      {/* Edit Connection Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <Dialog.Content className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
          <Dialog.Header>
            <Dialog.Title>Edit Connection</Dialog.Title>
            <Dialog.Description>Update the settings for this connection.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-name">Connection Name</Label>
              <Input
                id="edit-name"
                placeholder="My Google Connection"
                value={editFormData.name}
                onChange={(e) => setEditFormData({ ...editFormData, name: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label>Provider</Label>
              <div className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md">
                {mockConnection.provider.name} (cannot be changed)
              </div>
            </div>

            {/* Platform Instructions */}
            {(() => {
              const instructions = getPlatformInstructions(mockConnection.provider.name);

              if (!instructions) {
                return null;
              }

              return (
                <Collapsible open={showInstructionsInEdit} onOpenChange={setShowInstructionsInEdit}>
                  <div className="flex items-center gap-2">
                    <Collapsible.Trigger asChild>
                      <Button variant="outline" size="sm" className="justify-start">
                        <HelpCircle className="h-4 w-4 mr-2" />
                        API Setup Instructions
                        {showInstructionsInEdit ? (
                          <ChevronUp className="h-4 w-4 ml-2" />
                        ) : (
                          <ChevronDown className="h-4 w-4 ml-2" />
                        )}
                      </Button>
                    </Collapsible.Trigger>
                  </div>
                  <Collapsible.Content className="mt-2">{instructions}</Collapsible.Content>
                </Collapsible>
              );
            })()}

            <div className="grid gap-2">
              <Label htmlFor="edit-clientid">
                Client ID{' '}
                {getPlatformKey(mockConnection.provider.name) === 'microsoft'
                  ? '(Application ID)'
                  : getPlatformKey(mockConnection.provider.name) === 'meta'
                    ? '(App ID)'
                    : ''}
              </Label>
              <Input
                id="edit-clientid"
                placeholder={
                  getPlatformKey(mockConnection.provider.name) === 'microsoft'
                    ? 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
                    : getPlatformKey(mockConnection.provider.name) === 'meta'
                      ? '1234567890123456'
                      : 'your-client-id'
                }
                value={editFormData.clientid}
                onChange={(e) => setEditFormData({ ...editFormData, clientid: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-clientkey">
                Client Key{' '}
                {getPlatformKey(mockConnection.provider.name) === 'apple'
                  ? '(Team ID / Key ID)'
                  : '(Optional)'}
              </Label>
              <Input
                id="edit-clientkey"
                placeholder={
                  getPlatformKey(mockConnection.provider.name) === 'apple'
                    ? 'XXXXXXXXXX'
                    : 'your-client-key'
                }
                value={editFormData.clientkey}
                onChange={(e) => setEditFormData({ ...editFormData, clientkey: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-clientsecret">
                Client Secret{' '}
                {getPlatformKey(mockConnection.provider.name) === 'meta'
                  ? '(App Secret)'
                  : ''}
              </Label>
              <Input
                id="edit-clientsecret"
                type="password"
                placeholder="your-client-secret"
                value={editFormData.clientsecret}
                onChange={(e) => setEditFormData({ ...editFormData, clientsecret: e.target.value })}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-schedule">Sync Schedule</Label>
              <Select
                value={editFormData.schedule}
                onValueChange={(value) => setEditFormData({ ...editFormData, schedule: value })}
              >
                <Select.Trigger id="edit-schedule">
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="hourly">Hourly</Select.Item>
                  <Select.Item value="daily">Daily</Select.Item>
                  <Select.Item value="weekly">Weekly</Select.Item>
                </Select.Content>
              </Select>
            </div>
          </div>

          <Dialog.Footer>
            <Button variant="outline" onClick={() => setShowEditModal(false)}>
              Cancel
            </Button>
            <Button disabled={!editFormData.name}>
              Save (Demo)
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog>
    </div>
  );
}