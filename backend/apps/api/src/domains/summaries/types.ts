export interface CreateSummaryDto {
  summaryId?: string;
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  periodType: string;
  timezone?: string;
  sourceTypes: string[];
  title?: string | null;
  content: Record<string, unknown>;
  structuredContext?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
  participants?: string[] | null;
  confidenceScore?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateSummaryDto {
  title?: string | null;
  content?: Record<string, unknown>;
  structuredContext?: Record<string, unknown> | null;
  tags?: Record<string, unknown> | null;
  participants?: string[] | null;
  confidenceScore?: number | null;
  metadata?: Record<string, unknown> | null;
}
