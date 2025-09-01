export interface File {
  id: string;
  name: string;
  key: string;
  contentType: string;
  size: number;
  url?: string;
  parsedContent?: string;
  parsingStatus: 'pending' | 'processing' | 'completed' | 'failed';
  parsedMetadata?: Record<string, any>;
  parsingError?: string;
  parsedAt?: Date;
}
