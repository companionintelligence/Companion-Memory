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
