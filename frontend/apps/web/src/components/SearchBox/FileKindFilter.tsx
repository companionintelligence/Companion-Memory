import { Image as ImageIcon } from '@ci/shadcn/icons';
import { useSearchParams } from 'react-router-dom';

import {
  readCsvParam,
  writeCsvFilterParam,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';
import { FILE_KINDS, fileKindLabel, isFileKind } from '@/pages/MemoryPage/fileKinds';

import { FilterValuePicker, type FilterValuePickerProps } from './FilterValuePicker';

export const FILE_KINDS_PARAM = 'fileKinds';

interface Props {
  modal?: boolean;
  /** Dimension name on the trigger ("Kind: all"). */
  label?: string;
  /** Opens the picker from the caller's own element (the phone filter sheet's row). */
  renderTrigger?: FilterValuePickerProps['renderTrigger'];
}

/**
 * Which kinds of file: Images, Videos, Audio, Documents. A fixed list, not a
 * query — the kinds are read off a file's content type on the server, so
 * there is nothing to discover. Narrows files only; see `fileKinds.ts`.
 */
export function FileKindFilter({ modal = true, label = 'Kind', renderTrigger }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();
  const values = readCsvParam(searchParams, FILE_KINDS_PARAM);

  const write = (next: string[]) =>
    setSearchParams((params) => {
      writeCsvFilterParam(params, FILE_KINDS_PARAM, next);

      return params;
    });

  return (
    <FilterValuePicker
      variant="toolbar"
      label={label}
      icon={ImageIcon}
      modal={modal}
      values={values}
      options={[...FILE_KINDS]}
      optionsKnown
      formatValue={fileKindLabel}
      onAdd={(value) => {
        if (!isFileKind(value)) {
          return 'Pick one of the kinds listed.';
        }

        if (!values.includes(value)) {
          write([...values, value]);
        }

        return null;
      }}
      onRemove={(value) => write(values.filter((item) => item !== value))}
      onClear={() => write([])}
      searchPlaceholder="Images, videos, audio, documents…"
      emptyText="No kind matches"
      unknownValueHint="Files come in four kinds here; this is not one of them."
      renderTrigger={renderTrigger}
    />
  );
}
