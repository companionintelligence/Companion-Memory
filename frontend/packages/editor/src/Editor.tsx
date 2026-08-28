import { type ReactNode } from 'react';

import { Content } from './Content';
import type { EntityReferenceConfig } from './EntityReference';
import { Menu } from './Menu';
import { EditorProvider } from './useEditor';

interface Props {
  content?: string;
  onUpdate?: (content: string) => void;
  /** Enables `[[` references. Memoize it — see {@link EntityReferenceConfig}. */
  reference?: EntityReferenceConfig;
  children?: ReactNode;
}

export function Editor({ content, onUpdate, reference, children }: Props) {
  return <EditorProvider args={[{ content, onUpdate, reference }]}>{children}</EditorProvider>;
}

Editor.Menu = Menu;
Editor.Content = Content;
