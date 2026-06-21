import { z } from 'zod';

// G1 unified-capture ingest envelope (event-ingest-spec §4.2), pragmatic v1
// subset. Every capture source — importer, browser ext, pipe — POSTs this shape
// to /v1/events. `kind` is open text for v1; a closed enum + per-kind payload
// schema registry is a follow-up.
export const captureEventSchema = z.object({
  source_system: z.string().min(1),
  source_id: z.string().min(1),
  kind: z.string().min(1),
  occurred_at: z.string().datetime(),
  observed_at: z.string().datetime().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  payload: z.record(z.unknown()).default({}),
  confidence_score: z.number().min(0).max(1).optional(),
});

export const ingestEventsSchema = z.object({
  events: z.array(captureEventSchema).min(1).max(1000),
});

export type CaptureEvent = z.infer<typeof captureEventSchema>;
export type IngestEventsRequest = z.infer<typeof ingestEventsSchema>;

export interface IngestEventsResponse {
  ingested: number;
  duplicate: number;
  rejected: { index: number; reason: string }[];
}
