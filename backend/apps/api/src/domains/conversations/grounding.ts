/** Evidence actually admitted to a turn, retained with its database references. */
export interface MessageGrounding {
  status: 'retrieved' | 'empty' | 'timeout' | 'unavailable' | 'disabled' | 'budget_exhausted';
  sources: Array<{
    citation: number;
    text: string;
    voice: 'own' | 'other';
    ref: { type: string; id: string; at: string | null };
  }>;
  /** Checks existence of citation numbers, not whether prose follows from a source. */
  citations?: { cited: number[]; invalid: number[] };
}

export function verifyMemoryCitations(text: string, grounding: MessageGrounding): MessageGrounding {
  const cited = [...new Set([...text.matchAll(/\[M(\d+)\]/g)].map((match) => Number(match[1])))];
  const allowed = new Set(grounding.sources.map((source) => source.citation));

  return { ...grounding, citations: { cited, invalid: cited.filter((citation) => !allowed.has(citation)) } };
}
