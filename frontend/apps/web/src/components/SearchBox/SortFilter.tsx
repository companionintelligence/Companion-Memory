import { Label, Select } from '@ci/shadcn';
import { useSearchParams } from 'react-router-dom';

/**
 * Sort control for the search dropdown. Reads/writes the `sortBy`/`sortOrder`
 * URL params the explorer consumes. "Newest first" is the default and is kept
 * out of the URL to keep it clean.
 */
export function SortFilter() {
  const [searchParams, setSearchParams] = useSearchParams();

  const value = `${searchParams.get('sortBy') || 'time'}:${searchParams.get('sortOrder') || 'DESC'}`;

  const onChange = (next: string) => {
    const [by, order] = next.split(':');
    const params = new URLSearchParams(searchParams);

    if (by === 'time' && order === 'DESC') {
      params.delete('sortBy');
      params.delete('sortOrder');
    } else {
      params.set('sortBy', by);
      params.set('sortOrder', order);
    }

    setSearchParams(params);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="font-medium">Sort by</Label>
      <Select value={value} onValueChange={onChange}>
        <Select.Trigger className="w-56" aria-label="Sort results">
          <Select.Value placeholder="Sort" />
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="time:DESC">Newest first</Select.Item>
          <Select.Item value="time:ASC">Oldest first</Select.Item>
          <Select.Item value="name:ASC">Name A–Z</Select.Item>
          <Select.Item value="name:DESC">Name Z–A</Select.Item>
          <Select.Item value="relevance:DESC">Most relevant</Select.Item>
        </Select.Content>
      </Select>
    </div>
  );
}
