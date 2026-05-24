import { useRef, useEffect, useState } from 'react';

import { useQuery, useMutation } from '@apollo/client';
import { GlobalUID, LoadingPage, Portal, usePageTitle } from '@ci/common';
import { Editor } from '@ci/editor';
import { Breadcrumb, Spinner } from '@ci/shadcn';
import { Check, TriangleAlert } from '@ci/shadcn/icons';
import { useParams, useNavigate, Link } from 'react-router-dom';
import TimeAgo from 'react-timeago';

import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';

const AUTOSAVE_THROTTLE_MS = 1000;

const GET_NOTE = gql(`
  query GetNote($id: ID!) {
    note(id: $id) {
      id
      title
      content
      updatedAt
    }
  }
`);

const UPDATE_NOTE = gql(`
  mutation UpdateNote($input: UpdateNoteInput!) {
    updateNote(input: $input) {
      success
      note {
        id
        title
        content
        updatedAt
      }
    }
  }
`);

const CREATE_NOTE = gql(`
  mutation CreateNote($input: CreateNoteInput!) {
    createNote(input: $input) {
      success
      note {
        id
        title
        content
        updatedAt
      }
    }
  }
`);

export function NotePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data, loading } = useQuery(GET_NOTE, {
    variables: { id: GlobalUID.encode('note', id!) },
    skip: !id || id === 'new',
  });

  const [updateNote, { loading: updating }] = useMutation(UPDATE_NOTE);

  const [createNote, { loading: creating }] = useMutation(CREATE_NOTE, {
    update(cache, { data }) {
      if (data?.createNote && data.createNote.success) {
        cache.writeQuery({
          query: GET_NOTE,
          variables: {
            id: data.createNote.note!.id,
          },
          data: {
            note: data.createNote.note,
          },
        });

        cache.modify({
          fields: {
            notes(existingNotes = { edges: [] }) {
              const newNoteRef = cache.writeFragment({
                data: data.createNote.note,
                fragment: gql(`
                  fragment NewNote on NoteType {
                    id
                    title
                    content
                    updatedAt
                  }
                `),
              });

              return {
                ...existingNotes,
                edges: [{ node: newNoteRef }, ...existingNotes.edges],
              };
            },
          },
        });
      }
    },
  });

  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentRef = useRef<string | null>(null);
  const isCreatingRef = useRef(false);

  const [isDirty, setIsDirty] = useState(false);

  const note = data?.note;

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current && contentRef.current !== null) {
        clearTimeout(saveTimeoutRef.current);

        if (note?.id) {
          const content = contentRef.current;
          const title = extractTitle(content);

          updateNote({
            variables: {
              input: {
                id: note.id,
                title,
                content,
              },
            },
          });
        }
      }
    };
  }, [id, note?.id, updateNote, createNote]);

  usePageTitle(
    note?.title ? `Note - ${note.title} - Companion Intelligence` : 'Note - Companion Intelligence',
  );

  const handleUpdate = (content: string) => {
    contentRef.current = content;
    setIsDirty(true);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    if (id === 'new' && !hasContent(content)) {
      return;
    }

    saveTimeoutRef.current = setTimeout(async () => {
      saveTimeoutRef.current = null;

      const title = extractTitle(content);

      try {
        if (id === 'new') {
          if (isCreatingRef.current) {
            return;
          }

          isCreatingRef.current = true;

          const result = await createNote({
            variables: {
              input: {
                content,
                title,
              },
            },
          });

          if (result.data?.createNote?.note?.id) {
            const newId = GlobalUID.parse('note', result.data.createNote.note.id);

            navigate(`/notes/${newId}`, { replace: true });
          }

          setIsDirty(false);
        } else if (note?.id) {
          await updateNote({
            variables: {
              input: {
                id: note.id,
                content,
                title,
              },
            },
          });

          setIsDirty(false);
        }
      } catch (e) {
        console.error('Failed to save note', e);
      } finally {
        isCreatingRef.current = false;
      }
    }, AUTOSAVE_THROTTLE_MS);
  };

  if (loading) {
    return <LoadingPage />;
  }

  return (
    <>
      <Portal.Slot id="breadcrumbs">
        <Breadcrumb>
          <Breadcrumb.List>
            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/feed">Companion</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            <Breadcrumb.Separator className="hidden md:block" />

            <Breadcrumb.Item className="hidden md:block">
              <Breadcrumb.Link asChild>
                <Link to="/notes">Notes</Link>
              </Breadcrumb.Link>
            </Breadcrumb.Item>

            <Breadcrumb.Separator className="hidden md:block" />

            <Breadcrumb.Item>
              <Breadcrumb.Page>{note?.title || 'Untitled'}</Breadcrumb.Page>
            </Breadcrumb.Item>
          </Breadcrumb.List>
        </Breadcrumb>
      </Portal.Slot>

      <Editor key={id} content={note?.content ?? undefined} onUpdate={handleUpdate}>
        <div className="flex h-full flex-col overflow-hidden">
          <Editor.Menu>
            <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">
              {updating || creating ? (
                <>
                  <Spinner size={12} variant="circle" color="rgb(6,108,128)" />
                  <div>Saving</div>
                </>
              ) : isDirty ? (
                <>
                  <TriangleAlert className="text-amber-300 h-4 w-4" strokeWidth={1.5} />
                  <TimeAgo date={note?.updatedAt} minPeriod={5} formatter={shortFormatter} />
                </>
              ) : null}

              {id !== 'new' && !updating && !creating && !isDirty && (
                <>
                  <Check className="text-[rgb(6,108,128)] h-4 w-4 -mr-0.5" />
                  <TimeAgo date={note?.updatedAt} minPeriod={5} formatter={shortFormatter} />
                </>
              )}
            </div>
          </Editor.Menu>

          <div className="flex-1 min-h-0">
            <PageContent className="p-0">
              <Editor.Content />
            </PageContent>
          </div>
        </div>
      </Editor>
    </>
  );
}

function shortFormatter(value: string, unit: string) {
  switch (unit) {
    case 'second':
      return `${value}s ago`;
    case 'minute':
      return `${value}m ago`;
    case 'hour':
      return `${value}h ago`;
    case 'day':
      return `${value}d ago`;
    case 'week':
      return `${value}w ago`;
    case 'month':
      return `${value}mo ago`;
    case 'year':
      return `${value}y ago`;
    default:
      return '';
  }
}

function hasContent(content: string) {
  return content.replace(/<[^>]*>/g, '').trim().length > 0;
}

function extractTitle(content: string) {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const div = doc.body;

  const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();

  while (node) {
    if (node.textContent?.trim()) {
      let element = node.parentElement;
      while (element && element !== div) {
        if (
          ['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DIV'].includes(
            element.tagName,
          )
        ) {
          return element.textContent?.trim().substring(0, 100) || 'Untitled note';
        }

        element = element.parentElement;
      }

      return node.textContent?.trim().substring(0, 100) || 'Untitled note';
    }

    node = walker.nextNode();
  }

  return 'Untitled note';
}
