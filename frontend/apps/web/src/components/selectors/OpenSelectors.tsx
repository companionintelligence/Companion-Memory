import { Input } from '@ci/shadcn';

import type { SelectorValue } from './types';

interface Props {
  value: SelectorValue;
  onChange: (value: SelectorValue) => void;
  stem?: string;
  scaffold?: string;
}

function asText(value: SelectorValue): string {
  return typeof value === 'string' ? value : '';
}

export function OneLineSelector({ value, onChange }: Props) {
  return (
    <textarea
      rows={2}
      className="min-h-14 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm"
      value={asText(value)}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Type a short answer"
    />
  );
}

export function ParagraphSelector({ value, onChange }: Props) {
  return (
    <textarea
      className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
      value={asText(value)}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Write a bit more…"
    />
  );
}

export function GuidedWriteSelector({ value, onChange, scaffold }: Props) {
  return (
    <div className="flex flex-col gap-2">
      {scaffold ? <p className="text-xs text-muted-foreground">{scaffold}</p> : null}
      <ParagraphSelector value={value} onChange={onChange} />
    </div>
  );
}

export function SentenceStemSelector({ value, onChange, stem }: Props) {
  return (
    <div className="flex items-center gap-2">
      {stem ? <span className="shrink-0 text-sm text-muted-foreground">{stem}</span> : null}
      <Input value={asText(value)} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
