import { type ReactNode } from 'react';

import { EditorProvider } from './useEditor';
import { Menu } from './Menu';
import { Content } from './Content';

interface Props {
  content?: string;
  onUpdate?: (content: string) => void;
  children?: ReactNode;
}

export function Editor({ content, onUpdate, children }: Props) {
  return <EditorProvider args={[{ content, onUpdate }]}>{children}</EditorProvider>;
}

Editor.Menu = Menu;
Editor.Content = Content;
