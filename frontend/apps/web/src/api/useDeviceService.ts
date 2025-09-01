import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import type { Device, DeviceType, CreateDeviceDto, UpdateDeviceDto } from '../pages/DevicesPage/DevicesPage';

export function useDeviceService() {
  const [{ authToken }] = useAuth();

  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);

  const fetchDevices = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await fetchJson<Device[]>('/api/devices', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      setDevices(data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  const createDevice = useCallback(
    async (deviceDto: CreateDeviceDto): Promise<Device> => {
      const data = await fetchJson<Device>('/api/devices', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(deviceDto),
      });

      await fetchDevices(); // Refresh the list
      return data;
    },
    [authToken, fetchDevices],
  );

  const updateDevice = useCallback(
    async (id: string, deviceDto: UpdateDeviceDto): Promise<Device> => {
      const data = await fetchJson<Device>(`/api/devices/${id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(deviceDto),
      });

      await fetchDevices(); // Refresh the list
      return data;
    },
    [authToken, fetchDevices],
  );

  const deleteDevice = useCallback(
    async (id: string): Promise<void> => {
      await fetchJson(`/api/devices/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      await fetchDevices(); // Refresh the list
    },
    [authToken, fetchDevices],
  );

  const updateDeviceStatus = useCallback(
    async (id: string, status: Device['status']): Promise<void> => {
      await fetchJson(`/api/devices/${id}/status`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ status }),
      });

      await fetchDevices(); // Refresh the list
    },
    [authToken, fetchDevices],
  );

  const sendHeartbeat = useCallback(
    async (id: string): Promise<void> => {
      await fetchJson(`/api/devices/${id}/heartbeat`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      await fetchDevices(); // Refresh the list
    },
    [authToken, fetchDevices],
  );

  useEffect(() => {
    if (authToken) {
      fetchDevices();
    }
  }, [authToken, fetchDevices]);

  return {
    devices,
    loading,
    error,
    refetch: fetchDevices,
    createDevice,
    updateDevice,
    deleteDevice,
    updateDeviceStatus,
    sendHeartbeat,
  };
}