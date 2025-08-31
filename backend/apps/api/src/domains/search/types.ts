export interface SearchResult {
  text: string;
  type: string;
  id: string;
  path: string;
}

export interface EmbeddingSearchParams {
  input: string;
  type?: string;
  limit?: number;
}

export interface Tag {
  readonly id: string;
  readonly label: string | null;
  readonly user_id: string | null;
  readonly created_at: Date;
}

export interface CreateTagDto {
  label: string;
}

export interface UpdateTagDto {
  label?: string;
}
