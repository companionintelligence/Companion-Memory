import { Extension, mergeAttributes } from '@tiptap/core';
import { Mention } from '@tiptap/extension-mention';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { ReactRenderer } from '@tiptap/react';

import { ReferenceList } from './ReferenceList';
import type { ReferenceListHandle, ReferenceListProps } from './ReferenceList';
import type { EntityReferenceConfig, EntityReferenceItem } from './types';

export const ENTITY_REFERENCE_NAME = 'entityReference';

/** Wiki-style trigger. Multi-character triggers are escaped into the plugin's regex. */
const TRIGGER = '[[';

/** Gap between the caret and the menu, and the room needed to open downward. */
const MENU_OFFSET_PX = 6;
const MENU_MIN_SPACE_PX = 260;

/**
 * Claims a click on a reference chip before StarterKit's Link sees it.
 *
 * The chip renders as `<a href>`. Link's click handler (priority 1000, with
 * `openOnClick` on by default) opens the href of any anchor in the editor in a
 * new tab, so a chip click opened the page twice: in a new tab, and in this one
 * through `Content`'s `onReferenceClick`. A higher priority puts this plugin
 * ahead of Link's. Ordinary links are left to Link.
 */
const EntityReferenceClick = Extension.create({
  name: `${ENTITY_REFERENCE_NAME}Click`,
  priority: 1001,

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey(`${ENTITY_REFERENCE_NAME}Click`),
        props: {
          handleClick: (_view, _pos, event) =>
            event.button === 0 &&
            event.target instanceof Element &&
            event.target.closest('a[data-entity-uid]') !== null,
        },
      }),
    ];
  },
});

/**
 * `[[` reference node for notes.
 *
 * Deliberately a *node* rather than a link mark: the target's GlobalUID lives in
 * an attribute, so a reference survives the target being renamed and can render
 * as a chip with its own affordances. A link mark would bake the display text
 * and URL into the document and rot the moment either changed.
 *
 * References serialise to `<a data-entity-uid="…" data-entity-type="…">` inside
 * the note HTML, which is the whole of their persistence — nothing is written to
 * the graph, so there are no backlinks (yet).
 */
export function createEntityReference(config: EntityReferenceConfig) {
  return Mention.extend({
    name: ENTITY_REFERENCE_NAME,

    addExtensions() {
      return [EntityReferenceClick];
    },

    addAttributes() {
      return {
        uid: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-entity-uid'),
          renderHTML: (attributes) => (attributes.uid ? { 'data-entity-uid': attributes.uid as string } : {}),
        },
        entityType: {
          default: null,
          parseHTML: (element) => element.getAttribute('data-entity-type'),
          renderHTML: (attributes) =>
            attributes.entityType ? { 'data-entity-type': attributes.entityType as string } : {},
        },
        label: {
          default: null,
          // Read from the attribute rather than textContent so a reference whose
          // label contains markup still round-trips intact.
          parseHTML: (element) => element.getAttribute('data-entity-label') ?? element.textContent,
          renderHTML: (attributes) =>
            attributes.label ? { 'data-entity-label': attributes.label as string } : {},
        },
      };
    },

    parseHTML() {
      // StarterKit's Link mark also matches the anchor (`a[href]`). At equal
      // priority ProseMirror tries mark rules before node rules, so without this
      // a saved reference reloads as a plain link. 51 beats Link's default 50.
      return [{ tag: `a[data-entity-uid]`, priority: 51 }];
    },

    renderHTML({ node, HTMLAttributes }) {
      const uid = node.attrs.uid as string | null;
      const entityType = node.attrs.entityType as string | null;
      const label = (node.attrs.label as string | null) ?? '';

      return [
        'a',
        mergeAttributes(HTMLAttributes, {
          href: uid && entityType ? config.resolveHref({ uid, type: entityType }) : '#',
          class: 'ci-entity-reference',
        }),
        label,
      ];
    },

    /** Plain-text and copy/paste form keeps the wiki syntax legible. */
    renderText({ node }) {
      return `[[${(node.attrs.label as string | null) ?? ''}]]`;
    },
  }).configure({
    suggestion: {
      char: TRIGGER,
      // Entity names contain spaces, so the query cannot stop at the first one.
      allowSpaces: true,
      startOfLine: false,

      items: ({ query }: { query: string }) => config.search(query),

      command: ({ editor, range, props }) => {
        const item = props as unknown as EntityReferenceItem;

        editor
          .chain()
          .focus()
          .insertContentAt(range, [
            {
              type: ENTITY_REFERENCE_NAME,
              attrs: { uid: item.uid, entityType: item.type, label: item.label },
            },
            // Trailing space so typing continues outside the (atomic) chip.
            { type: 'text', text: ' ' },
          ])
          .run();
      },

      render: () => {
        let renderer: ReactRenderer<ReferenceListHandle, ReferenceListProps> | null = null;
        let container: HTMLDivElement | null = null;

        const place = (rect: DOMRect | null | undefined) => {
          if (!container || !rect) {
            return;
          }

          // Flip above the caret when there is not enough room below, so the
          // menu is never clipped by the viewport edge.
          const below = window.innerHeight - rect.bottom;
          const openUp = below < MENU_MIN_SPACE_PX && rect.top > below;

          container.style.left = `${rect.left}px`;

          if (openUp) {
            container.style.top = '';
            container.style.bottom = `${window.innerHeight - rect.top + MENU_OFFSET_PX}px`;
          } else {
            container.style.bottom = '';
            container.style.top = `${rect.bottom + MENU_OFFSET_PX}px`;
          }
        };

        return {
          onStart: (props) => {
            renderer = new ReactRenderer(ReferenceList, {
              props: { items: props.items, command: props.command },
              editor: props.editor,
            });

            container = document.createElement('div');
            container.style.position = 'fixed';
            container.style.zIndex = '50';
            container.appendChild(renderer.element);
            document.body.appendChild(container);

            place(props.clientRect?.());
          },

          onUpdate: (props) => {
            renderer?.updateProps({ items: props.items, command: props.command });
            place(props.clientRect?.());
          },

          onKeyDown: (props) => {
            if (props.event.key === 'Escape' || props.event.key === 'Esc') {
              // Two things have to happen, and neither is the obvious one.
              //
              // Stop propagation: `useEditor` blurs the editor on a *window*
              // keydown, which would otherwise fire as well and drop the caret
              // while the user only meant to close the menu.
              //
              // Return false: @tiptap/suggestion's own Escape branch asks this
              // hook first and, when it answers true, skips its exit path
              // entirely — claiming the key would leave the menu on screen.
              props.event.stopPropagation();

              return false;
            }

            return renderer?.ref?.onKeyDown(props.event) ?? false;
          },

          onExit: () => {
            renderer?.destroy();
            container?.remove();
            renderer = null;
            container = null;
          },
        };
      },
    },
  });
}
