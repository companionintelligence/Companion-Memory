export enum ParseStatus {
  PROCESSING = 'processing',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
}

export const CHUNKER_VERSION = '1.2.0';

/** Target chunk size in characters (~1000 tokens at ~4 chars/token) */
export const CHUNK_TARGET_CHARS = 4000;
/** Overlap between consecutive chunks in characters (~15%) */
export const CHUNK_OVERLAP_CHARS = 600;

// --------------------------------------------------------------------------
// Parser service response types (mirrors Python ParsedDocument model)
// --------------------------------------------------------------------------

export type ParsedSection = {
  sectionId: string;
  title: string | null;
  text: string;
  metadata: Record<string, unknown>;
};

export type ParsedDocument = {
  parser: { name: string; version: string };
  title: string | null;
  language: string | null;
  sections: ParsedSection[];
  warnings: string[];
};

// --------------------------------------------------------------------------
// Chunk DTO used internally when persisting chunks
// --------------------------------------------------------------------------

export type CreateChunkDto = {
  fileId: string;
  userId: string;
  chunkIndex: number;
  content: string;
  sectionTitle: string | null;
  sourceLocator: Record<string, unknown> | null;
  parserName: string;
  parserVersion: string;
  chunkerVersion: string;
};
