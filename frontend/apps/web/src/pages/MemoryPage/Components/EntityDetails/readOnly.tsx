import { createContext, useContext, type ReactNode } from 'react';

/**
 * Whether the entity detail drawer is in read-only mode. The shared-search
 * viewer (/shared/:token) reuses the full EntityDetails sheet but must not offer
 * edit/tag affordances or an "Open full page" escape hatch on the owner's data —
 * those mutations are owner-scoped and would silently no-op (or write stray tag
 * rows in the viewer's own scope). Defaults to false so the owner's MemoryPage
 * is unaffected.
 */
const ReadOnlyContext = createContext(false);

export function ReadOnlyProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <ReadOnlyContext.Provider value={value}>{children}</ReadOnlyContext.Provider>;
}

export function useReadOnly(): boolean {
  return useContext(ReadOnlyContext);
}
