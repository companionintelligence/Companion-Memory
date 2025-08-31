import { useState, useEffect, useCallback } from 'react';

import { Portal, usePageTitle } from '@ci/common';
import { Breadcrumb, Button, Table, Dialog, Input, Label, Select } from '@ci/shadcn';
import {
  AlertCircle,
  Plus,
  Settings,
  Trash2,
  Smartphone,
  Laptop,
  Headphones,
  Camera,
  Glasses,
} from '@ci/shadcn/icons';

import { PageContent } from '@/components/layout';

// Device type definitions for supported devices
export type DeviceType =
  | 'quest3'
  | 'xreal-ultra'
  | 'xreal-one'
  | 'xreal-one-pro'
  | 'xreal-air-2'
  | 'ios'
  | 'android'
  | 'windows-app'
  | 'mac-app'
  | 'sipeed-maixcam'
  | 'sipeed-maixcam-pro'
  | 'omi-pendant'
  | 'omi-glasses';

export interface Device {
  readonly id: string;
  readonly name: string;
  readonly type: DeviceType;
  readonly status: 'connected' | 'disconnected' | 'authorized' | 'unauthorized';
  readonly lastSeen?: Date;
  readonly ipAddress?: string;
  readonly userAgent?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// Device type display names and icons
const DEVICE_TYPES: Record<DeviceType, { label: string; icon: React.ComponentType<{ className?: string }> }> =
  {
    quest3: { label: 'Quest 3', icon: Headphones },
    'xreal-ultra': { label: 'XReal Ultra', icon: Glasses },
    'xreal-one': { label: 'XReal One', icon: Glasses },
    'xreal-one-pro': { label: 'XReal One Pro', icon: Glasses },
    'xreal-air-2': { label: 'XReal Air 2', icon: Glasses },
    ios: { label: 'iOS', icon: Smartphone },
    android: { label: 'Android', icon: Smartphone },
    'windows-app': { label: 'Windows App', icon: Laptop },
    'mac-app': { label: 'Mac App', icon: Laptop },
    'sipeed-maixcam': { label: 'Sipeed MaixCAM', icon: Camera },
    'sipeed-maixcam-pro': { label: 'Sipeed MaixCAM Pro', icon: Camera },
    'omi-pendant': { label: 'Omi Pendant', icon: Smartphone },
    'omi-glasses': { label: 'Omi Glasses', icon: Glasses },
  };

// Helper function to get icon for device type
function getDeviceIcon(type: DeviceType): React.ReactNode {
  const DeviceIcon = DEVICE_TYPES[type]?.icon || Smartphone;

  return <DeviceIcon className="h-5 w-5" />;
}

// Helper function to get status badge color
function getStatusColor(status: Device['status']): string {
  switch (status) {
    case 'connected':
      return 'bg-green-100 text-green-800';
    case 'authorized':
      return 'bg-blue-100 text-blue-800';
    case 'disconnected':
      return 'bg-gray-100 text-gray-800';
    case 'unauthorized':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-gray-100 text-gray-800';
  }
}

// Mock data for demonstration - in real app this would come from API
const MOCK_DEVICES: Device[] = [
  {
    id: '1',
    name: 'iPhone 15 Pro',
    type: 'ios',
    status: 'connected',
    lastSeen: new Date(Date.now() - 1000 * 60 * 5), // 5 minutes ago
    ipAddress: '192.168.1.100',
    userAgent: 'CI-iOS-App/1.0',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7), // 1 week ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 5),
  },
  {
    id: '2',
    name: 'MacBook Pro',
    type: 'mac-app',
    status: 'connected',
    lastSeen: new Date(Date.now() - 1000 * 60 * 15), // 15 minutes ago
    ipAddress: '192.168.1.101',
    userAgent: 'CI-Desktop-App/1.2.0',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30), // 30 days ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 15),
  },
  {
    id: '3',
    name: 'Quest 3 Headset',
    type: 'quest3',
    status: 'disconnected',
    lastSeen: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
    ipAddress: '192.168.1.102',
    userAgent: 'CI-VR-App/0.9.0',
    createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 14), // 2 weeks ago
    updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 2),
  },
];

export function DevicesPage() {
  usePageTitle('Devices - Companion Intelligence');

  const [devices, setDevices] = useState<Device[]>(MOCK_DEVICES);
  const [loading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Modal state
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);

  // Form state
  const [addFormData, setAddFormData] = useState({
    name: '',
    type: 'ios' as DeviceType,
  });

  const [editFormData, setEditFormData] = useState({
    name: '',
    type: 'ios' as DeviceType,
  });

  const [modalError, setModalError] = useState<string | null>(null);
  const [modalLoading, setModalLoading] = useState(false);

  // Clear messages after a delay
  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 5000);

      return () => clearTimeout(timer);
    }
  }, [successMessage]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 5000);

      return () => clearTimeout(timer);
    }
  }, [error]);

  // Format last seen time
  const formatLastSeen = useCallback((date?: Date): string => {
    if (!date) {
      return 'Never';
    }

    const now = Date.now();
    const diff = now - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));

    if (minutes < 1) {
      return 'Just now';
    }

    if (minutes < 60) {
      return `${minutes}m ago`;
    }

    if (hours < 24) {
      return `${hours}h ago`;
    }

    return `${days}d ago`;
  }, []);

  // Handle add device
  const handleAddDevice = async () => {
    if (!addFormData.name.trim()) {
      setModalError('Device name is required');

      return;
    }

    setModalLoading(true);
    setModalError(null);

    try {
      // In a real app, this would be an API call
      const newDevice: Device = {
        id: Math.random().toString(36).substr(2, 9),
        name: addFormData.name.trim(),
        type: addFormData.type,
        status: 'unauthorized',
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      setDevices((prev) => [...prev, newDevice]);
      setShowAddModal(false);
      setAddFormData({ name: '', type: 'ios' });
      setSuccessMessage('Device added successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setModalError(errorMessage);
    } finally {
      setModalLoading(false);
    }
  };

  // Handle edit device
  const handleEditDevice = (device: Device) => {
    setSelectedDevice(device);
    setEditFormData({
      name: device.name,
      type: device.type,
    });
    setShowEditModal(true);
  };

  // Handle update device
  const handleUpdateDevice = async () => {
    if (!editFormData.name.trim() || !selectedDevice) {
      setModalError('Device name is required');

      return;
    }

    setModalLoading(true);
    setModalError(null);

    try {
      // In a real app, this would be an API call
      setDevices((prev) =>
        prev.map((device) =>
          device.id === selectedDevice.id
            ? {
                ...device,
                name: editFormData.name.trim(),
                type: editFormData.type,
                updatedAt: new Date(),
              }
            : device,
        ),
      );

      setShowEditModal(false);
      setSelectedDevice(null);
      setSuccessMessage('Device updated successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setModalError(errorMessage);
    } finally {
      setModalLoading(false);
    }
  };

  // Handle delete device
  const handleDeleteDevice = async (device: Device) => {
    if (!confirm(`Are you sure you want to remove "${device.name}"?`)) {
      return;
    }

    setDeleteLoading(device.id);
    setError(null);

    try {
      // In a real app, this would be an API call
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Simulate API call

      setDevices((prev) => prev.filter((d) => d.id !== device.id));
      setSuccessMessage('Device removed successfully');
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'An unknown error occurred';
      setError(errorMessage);
    } finally {
      setDeleteLoading(null);
    }
  };

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link href="/">Home</Breadcrumb.Link>
            </Breadcrumb.Item>
            <Breadcrumb.Separator className="hidden md:block" />
            <Breadcrumb.Item>
              <Breadcrumb.Page>Devices</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <PageContent>
        <div className="flex flex-row items-center justify-between">
          <h1 className="text-2xl font-bold">Linked Devices</h1>
          <Button onClick={() => setShowAddModal(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Device
          </Button>
        </div>

        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}

        {successMessage && (
          <div className="bg-green-50 text-green-800 rounded-md p-3 text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            {successMessage}
          </div>
        )}

        {loading ? (
          <div className="text-center py-8 text-muted-foreground">Loading devices...</div>
        ) : (
          <>
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>Device</Table.Head>
                  <Table.Head>Type</Table.Head>
                  <Table.Head>Status</Table.Head>
                  <Table.Head>Last Seen</Table.Head>
                  <Table.Head>IP Address</Table.Head>
                  <Table.Head className="text-right">Actions</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {devices.length === 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={6} className="text-center py-8 text-muted-foreground">
                      No devices found. Add your first device to get started.
                    </Table.Cell>
                  </Table.Row>
                ) : (
                  devices.map((device) => (
                    <Table.Row key={device.id}>
                      <Table.Cell className="font-medium">
                        <div className="flex items-center gap-2">
                          {getDeviceIcon(device.type)}
                          {device.name}
                        </div>
                      </Table.Cell>
                      <Table.Cell>{DEVICE_TYPES[device.type]?.label || device.type}</Table.Cell>
                      <Table.Cell>
                        <span className={`px-2 py-1 rounded-full text-xs ${getStatusColor(device.status)}`}>
                          {device.status}
                        </span>
                      </Table.Cell>
                      <Table.Cell className="text-sm text-muted-foreground">
                        {formatLastSeen(device.lastSeen)}
                      </Table.Cell>
                      <Table.Cell className="text-sm text-muted-foreground">
                        {device.ipAddress || 'N/A'}
                      </Table.Cell>
                      <Table.Cell className="text-right">
                        <div className="flex gap-2 justify-end">
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleEditDevice(device)}
                            disabled={deleteLoading === device.id}
                            title="Edit"
                          >
                            <Settings className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => handleDeleteDevice(device)}
                            disabled={deleteLoading === device.id}
                            title="Remove"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </Table.Cell>
                    </Table.Row>
                  ))
                )}
              </Table.Body>
            </Table>

            <div className="text-xs text-muted-foreground">Total Devices: {devices.length}</div>
          </>
        )}
      </PageContent>

      {/* Add Device Modal */}
      <Dialog open={showAddModal} onOpenChange={setShowAddModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Add Device</Dialog.Title>
            <Dialog.Description>Add a new device to your linked devices.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            {modalError && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{modalError}</div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="add-name">Device Name</Label>
              <Input
                id="add-name"
                placeholder="Enter device name (e.g. 'My iPhone')"
                value={addFormData.name}
                onChange={(e) => setAddFormData((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="add-type">Device Type</Label>
              <Select
                value={addFormData.type}
                onValueChange={(value) => setAddFormData((prev) => ({ ...prev, type: value as DeviceType }))}
              >
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {Object.entries(DEVICE_TYPES).map(([type, config]) => (
                    <Select.Item key={type} value={type}>
                      {config.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowAddModal(false)} disabled={modalLoading}>
              Cancel
            </Button>
            <Button onClick={handleAddDevice} disabled={modalLoading}>
              {modalLoading ? 'Adding...' : 'Add Device'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>

      {/* Edit Device Modal */}
      <Dialog open={showEditModal} onOpenChange={setShowEditModal}>
        <Dialog.Content className="sm:max-w-[500px]">
          <Dialog.Header>
            <Dialog.Title>Edit Device</Dialog.Title>
            <Dialog.Description>Update device information.</Dialog.Description>
          </Dialog.Header>

          <div className="grid gap-4 py-4">
            {modalError && (
              <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{modalError}</div>
            )}

            <div className="grid gap-2">
              <Label htmlFor="edit-name">Device Name</Label>
              <Input
                id="edit-name"
                placeholder="Enter device name"
                value={editFormData.name}
                onChange={(e) => setEditFormData((prev) => ({ ...prev, name: e.target.value }))}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="edit-type">Device Type</Label>
              <Select
                value={editFormData.type}
                onValueChange={(value) => setEditFormData((prev) => ({ ...prev, type: value as DeviceType }))}
              >
                <Select.Trigger>
                  <Select.Value />
                </Select.Trigger>
                <Select.Content>
                  {Object.entries(DEVICE_TYPES).map(([type, config]) => (
                    <Select.Item key={type} value={type}>
                      {config.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setShowEditModal(false)} disabled={modalLoading}>
              Cancel
            </Button>
            <Button onClick={handleUpdateDevice} disabled={modalLoading}>
              {modalLoading ? 'Updating...' : 'Update Device'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </>
  );
}
