import { z } from 'zod';

import type {
  Position,
  LocationSource,
  RelativeCoordinates,
  RelativeOrientation,
} from './entities/PositionEntity';

export interface Coordinate {
  longitude: number;
  latitude: number;
}

export interface GeofenceRadius {
  center: Coordinate;
  radius_meters: number;
}

export interface GeofencePolygon {
  coordinates: Coordinate[];
}

export type Geofence = GeofenceRadius | GeofencePolygon;

export const createPositionSchemaRoot = z.object({
  time: z.string().datetime(),
  device_id: z.string().uuid().optional(),
  location: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  altitude_meters: z.number().optional(),
  accuracy_meters: z.number().positive().optional(),
  hdop: z.number().optional(),
  vdop: z.number().optional(),
  heading_degrees: z.number().optional(),
  speed_meters_per_second: z.number().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  provider: z.string().optional(),
  source: z.enum(['gps', 'wifi', 'cell_tower', 'manual', 'inferred', 'other']),
  activity_type: z.string().optional(),
  location_entity_id: z.string().uuid().optional(),
  reference_entity_id: z.string().uuid().optional(),
  relative_coordinates: z.record(z.unknown()).optional(),
  relative_orientation: z.record(z.unknown()).optional(),
  // Provenance triple for bulk-ingested fixes (#1672). Previously stripped
  // silently, so importer positions lost their origin on the wire.
  source_type: z.string().optional(),
  source_system: z.string().optional(),
  source_id: z.string().optional(),
});

export const createPositionSchema = z.array(createPositionSchemaRoot);

export const updatePositionSchema = z.object({
  time: z.string().datetime().optional(),
  device_id: z.string().uuid().optional(),
  location: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .optional(),
  altitude_meters: z.number().optional(),
  accuracy_meters: z.number().positive().optional(),
  hdop: z.number().optional(),
  vdop: z.number().optional(),
  heading_degrees: z.number().optional(),
  speed_meters_per_second: z.number().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  postal_code: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  provider: z.string().optional(),
  source: z.enum(['gps', 'wifi', 'cell_tower', 'manual', 'inferred', 'other']),
  activity_type: z.string().optional(),
  location_entity_id: z.string().uuid().optional(),
  reference_entity_id: z.string().uuid().optional(),
  relative_coordinates: z.record(z.unknown()).optional(),
  relative_orientation: z.record(z.unknown()).optional(),
});

export interface CreatePositionDto {
  time: string;
  device_id?: string;
  location?: {
    x: number;
    y: number;
  };
  altitude_meters?: number;
  accuracy_meters?: number;
  hdop?: number;
  vdop?: number;
  heading_degrees?: number;
  speed_meters_per_second?: number;
  address?: string;
  city?: string;
  region?: string;
  country?: string;
  postal_code?: string;
  name?: string;
  description?: string;
  provider?: string;
  source: LocationSource;
  activity_type?: string;
  location_entity_id?: string;
  reference_entity_id?: string;
  relative_coordinates?: RelativeCoordinates | Record<string, unknown>;
  relative_orientation?: RelativeOrientation | Record<string, unknown>;
  // Provenance triple for bulk-ingested fixes (#1672).
  source_type?: string;
  source_system?: string;
  source_id?: string;
}

export interface UpdatePositionDto {
  time?: string;
  device_id?: string;
  location?: {
    x: number;
    y: number;
  };
  altitude_meters?: number;
  accuracy_meters?: number;
  hdop?: number;
  vdop?: number;
  heading_degrees?: number;
  speed_meters_per_second?: number;
  address?: string;
  city?: string;
  region?: string;
  country?: string;
  postal_code?: string;
  name?: string;
  description?: string;
  provider?: string;
  source: LocationSource;
  activity_type?: string;
  location_entity_id?: string;
  reference_entity_id?: string;
  relative_coordinates?: RelativeCoordinates | Record<string, unknown>;
  relative_orientation?: RelativeOrientation | Record<string, unknown>;
}

export type { Position, LocationSource, RelativeCoordinates, RelativeOrientation };
