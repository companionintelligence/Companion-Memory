import { Link } from 'react-router-dom';

export interface Grounding {
  status: 'retrieved' | 'empty' | 'timeout' | 'unavailable' | 'disabled' | 'budget_exhausted';
  sources: {
    citation: number;
    text: string;
    voice: 'own' | 'other';
    ref: { type: string; id: string; at?: string };
  }[];
  citations?: { cited: number[]; invalid: number[] };
}

const statusMessages: Record<Grounding['status'], string> = {
  retrieved: 'Memory sources available to this answer',
  empty: 'No matching memories found. This answer may rely on general knowledge.',
  timeout: 'Memory lookup timed out. This answer may be missing relevant memories.',
  unavailable: 'Memory lookup is unavailable. This answer may be missing relevant memories.',
  disabled: 'Memory lookup was turned off for this answer.',
  budget_exhausted: 'Memory lookup reached its time limit. This answer may be missing relevant memories.',
};

/** This metadata arrives over the wire; malformed data must not break a conversation. */
export function parseGrounding(value: unknown): Grounding | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const grounding = value as Partial<Grounding>;

  if (
    !grounding.status ||
    !Object.prototype.hasOwnProperty.call(statusMessages, grounding.status) ||
    !Array.isArray(grounding.sources)
  ) {
    return null;
  }

  const sources = grounding.sources.filter(
    (source) =>
      source &&
      Number.isInteger(source.citation) &&
      source.citation > 0 &&
      typeof source.text === 'string' &&
      source.ref &&
      typeof source.ref.type === 'string' &&
      typeof source.ref.id === 'string',
  );
  const citations =
    grounding.citations &&
    Array.isArray(grounding.citations.invalid) &&
    Array.isArray(grounding.citations.cited)
      ? {
          invalid: grounding.citations.invalid.filter(Number.isInteger),
          cited: grounding.citations.cited.filter(Number.isInteger),
        }
      : undefined;

  return { status: grounding.status, sources, ...(citations ? { citations } : {}) };
}

function sourcePath(ref: Grounding['sources'][number]['ref']): string | null {
  const routes: Record<string, string> = {
    note: '/notes/',
    Note: '/notes/',
    NoteType: '/notes/',
    event: '/events/',
    Event: '/events/',
    EventType: '/events/',
    person: '/people/',
    Person: '/people/',
    PersonType: '/people/',
    place: '/places/',
    Place: '/places/',
    PlaceType: '/places/',
    content: '/content/',
    Content: '/content/',
    ContentType: '/content/',
  };
  const route = routes[ref.type];

  return route ? `${route}${encodeURIComponent(ref.id)}` : null;
}

export function GroundingSources({ value }: { value: unknown }) {
  const grounding = parseGrounding(value);

  if (!grounding) {
    return null;
  }

  const warning = grounding.status !== 'retrieved' || Boolean(grounding.citations?.invalid.length);

  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${warning ? 'border-amber-500/40 bg-amber-500/5' : 'border-border bg-muted/30'}`}
    >
      <p role="status">{statusMessages[grounding.status]}</p>
      {grounding.citations && grounding.citations.invalid.length > 0 && (
        <p className="mt-1 font-medium">
          This answer includes source markers that could not be verified:{' '}
          {grounding.citations.invalid.map((n) => `[M${n}]`).join(', ')}. Check the sources before relying on
          it.
        </p>
      )}
      {grounding.sources.length > 0 && (
        <details className="mt-1">
          <summary className="min-h-11 cursor-pointer py-2 font-medium">
            View {grounding.sources.length} memory {grounding.sources.length === 1 ? 'source' : 'sources'}
          </summary>
          <p className="mb-2 text-muted-foreground">
            These memories were supplied to the model. Their presence does not verify every claim in the
            answer.
          </p>
          <ol className="space-y-3">
            {grounding.sources.map((source) => {
              const path = sourcePath(source.ref);

              return (
                <li key={source.citation} className="break-words">
                  <span className="font-medium">
                    [M{source.citation}] {source.ref.type}
                  </span>
                  {source.voice === 'other' && (
                    <span className="ml-1 text-muted-foreground">· someone else’s words</span>
                  )}
                  <p className="mt-1 whitespace-pre-wrap">{source.text}</p>
                  {path && (
                    <Link className="mt-1 inline-block min-h-11 py-2 underline" to={path}>
                      Open source
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </details>
      )}
    </div>
  );
}
