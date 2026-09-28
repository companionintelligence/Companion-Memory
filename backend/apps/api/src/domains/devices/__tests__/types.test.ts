import { createDeviceSchema, updateDeviceSchema } from '../types';

describe('createDeviceSchema device_type', () => {
  it('accepts smart_glasses (CI-Mentra registers the glasses as this type)', () => {
    const result = createDeviceSchema.safeParse({
      device_name: 'Mentra Live',
      device_type: 'smart_glasses',
      manufacturer: 'Mentra',
    });
    expect(result.success).toBe(true);
  });

  it('still accepts the existing types', () => {
    expect(createDeviceSchema.safeParse({ device_type: 'smart_speaker' }).success).toBe(true);
    expect(createDeviceSchema.safeParse({ device_type: 'smartphone' }).success).toBe(true);
  });

  it('rejects an unknown device_type', () => {
    expect(createDeviceSchema.safeParse({ device_type: 'glasses' }).success).toBe(false);
  });

  it('accepts smart_glasses on update', () => {
    expect(updateDeviceSchema.safeParse({ device_type: 'smart_glasses' }).success).toBe(true);
  });
});
