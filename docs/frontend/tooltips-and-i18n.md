# Tooltips and i18n (web frontend)

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Two conventions that travel together: every icon-only control gets a tooltip, and
the tooltip text comes from a translation key.

## Tooltips

Use `IconButton` from `@ci/shadcn` for icon-only buttons. It is the house wrapper
around the Radix tooltip and the shadcn `Button`:

```tsx
import { IconButton } from '@ci/shadcn';
import { Trash } from '@ci/shadcn/icons';
import { useTranslation } from 'react-i18next';

const { t } = useTranslation();

<IconButton label={t('NOTES_DELETE')} variant="ghost" onClick={onDelete}>
  <Trash />
</IconButton>;
```

`label` is required and feeds **both** the tooltip and `aria-label`, so the hover
affordance and the screen-reader name cannot drift apart. That is enforced, not just
asked for: `aria-label` is `Omit`-ed from the props type, and it is applied *after*
the prop spread so it still wins for callers the type cannot see (an untyped spread,
a cast). Use `tooltip` when the bubble should read differently from the name.
Everything else (`variant`, `className`, `disabled`, `asChild`, `data-testid`)
forwards to `Button`; `size` defaults to `icon`.

| Prop | Use it for |
|---|---|
| `tooltip` | Tooltip text that should differ from the accessible name (e.g. a long explanation of *why* a control is disabled) |
| `side` / `align` | Placement, when the default would collide with a panel edge |
| `delayDuration` | Hover delay; defaults to 600ms |

A disabled `Button` gets `pointer-events: none` from `buttonVariants`, which would
swallow the hover. `IconButton` anchors the tooltip to a wrapper span when
`disabled` is set, so the tooltip still explains why the control is off.

**Controls that are not a shadcn `Button`** — `Toggle`, `ToggleGroup.Item`,
`Tabs.Trigger`, `Avatar`, raw `<button>`, badges, status dots — keep their own
element and get the `Tooltip` primitive instead:

```tsx
import { Tooltip } from '@ci/shadcn';

<Tooltip delayDuration={600}>
  <Tooltip.Content>{t('ENTITY_EDIT_TOGGLE')}</Tooltip.Content>
  <Tooltip.Trigger asChild>
    <Toggle aria-label={t('ENTITY_EDIT_TOGGLE')} pressed={editMode} onPressedChange={setEditMode}>
      <Pencil />
    </Toggle>
  </Tooltip.Trigger>
</Tooltip>;
```

**Never use the raw `title` attribute.** It is unstyled, slow to appear, invisible
on touch, and it renders *in addition to* a Radix tooltip when both are present.

### Never make a stateful Radix trigger the direct child of `Tooltip.Trigger`

`Tooltip.Trigger` writes its own `data-state` (`closed` / `delayed-open`), and
Radix's `Slot` only lets the child win for props the child itself declares. Wrap a
`Toggle`, `ToggleGroup.Item`, or another `*.Trigger` directly and the tooltip's
value lands on the DOM node, so `data-[state=on]` and `data-[state=open]` never
match again — the control keeps working and stays correct for screen readers, but
every trace of its pressed/open styling silently disappears.

Two ways out, both used in this codebase:

```tsx
// A neutral span absorbs the tooltip's data-state (standalone Toggle)
<Tooltip.Trigger asChild>
  <span className="inline-flex">
    <Toggle pressed={editMode} …>…</Toggle>
  </span>
</Tooltip.Trigger>

// Or put the tooltip innermost, so the other trigger's state wins (menus, popovers)
<DropdownMenu.Trigger asChild>
  <Tooltip.Trigger asChild>
    <button …>…</button>
  </Tooltip.Trigger>
</DropdownMenu.Trigger>
```

Prefer the inner-tooltip form for menu and popover triggers. Use the span only
where a wrapper is harmless — inside a `ToggleGroup` it would make every item both
`:first-child` and `:last-child`, rounding all four corners of every segment; there,
restate `data-state` on the item instead. `IconButton` is immune to all of this:
it spreads incoming props onto the real `Button` element, so they win the merge.

### Tooltips on menu entries

The Add menu and the account menu wrap each entry, so `Tooltip.Trigger asChild`
sits directly around `DropdownMenu.Item`. That is safe: `DropdownMenuItem` styles
on `data-[highlighted]`, `data-[disabled]` and `data-[variant]`, never on
`data-state`. The trigger does overwrite the item's `data-slot`, which nothing
reads — pinned in `MenuItemTooltip.test.tsx` so it fails if that changes.

```tsx
<Tooltip delayDuration={600}>
  <Tooltip.Content side="top" className="pointer-events-none">
    {t('NAV_ADD_NOTE')}
  </Tooltip.Content>
  <Tooltip.Trigger asChild>
    <DropdownMenu.Item onSelect={…}>…</DropdownMenu.Item>
  </Tooltip.Trigger>
</Tooltip>
```

Two rules specific to menus:

- **`pointer-events-none` on the content.** A bubble that overlaps a sibling entry
  would otherwise swallow the hover that highlights it.
- **Pick `side` so the bubble leaves the menu.** It should not cover the entries
  around it: `top` for the upper grid, `bottom` for the lower one, `left` for a
  right-aligned vertical menu.

These entries already show a text label, so the tooltip must *describe* the entry
(`Predict` → "Run the prediction pipeline now"). A tooltip that repeats a visible
label is noise. **`DropdownMenu.SubTrigger` gets no tooltip** — it styles on
`data-[state=open]`, and hovering it already opens the submenu.

### Delay behaviour

The exported `Tooltip` always mounts its own `TooltipProvider`, and Radix reads the
delay from the *nearest* provider. So an outer `Tooltip.Provider` has no effect,
and Radix's `skipDelayDuration` — which normally lets a second tooltip open
instantly as you sweep along a toolbar — never engages: every control waits the
full delay. Fixing that means dropping the self-wrap and mounting one provider in
`App.tsx`, which is a change to the shared primitive and its ~150 call sites (74
direct `<Tooltip>` roots plus ~80 `IconButton`s, each of which mounts one), so it
is deliberately left for its own PR.

## i18n

The mechanism mirrors CI-Hub so translator tooling and key conventions stay shared
across the two apps: i18next + react-i18next, one `translation` namespace, flat
`SCREAMING_SNAKE_CASE` keys, `en.json` as the Crowdin source.

- Strings: [`frontend/packages/common/i18n/translations/en.json`](../../frontend/packages/common/i18n/translations/en.json)
- Init: [`frontend/apps/web/src/lib/i18n.ts`](../../frontend/apps/web/src/lib/i18n.ts), called from `main.tsx` and from the vitest setup
- Crowdin: [`crowdin.yml`](../../crowdin.yml) at the repo root

```tsx
const { t } = useTranslation();

t('COMMON_CLOSE');
t('UPLOAD_REMOVE_FILE', { name: file.name }); // {{name}} interpolation
```

### Copy is governed by CI-Common

`CI-Common/content/brand-voice.md` is the org-wide source of truth for what the
product says. Two rules are absolutes and are enforced here by
`src/lib/i18nBrandVoice.node.test.ts`, because CI-Common's own `lint:voice` script
is still a `TODO` stub and this repo does not consume
`@companionintelligence/content`:

- **No em or en dashes in user-facing copy.** Commas for light pauses, semicolons
  for independent clauses. (They remain fine in code comments and these docs.)
- **Product nouns are Title Case** — Companion Hub, Companion Memory, your Core.
  Never genericize them to "knowledge base", "app store", "memory system".
  Everything else, including button labels, is sentence case.

Note the key style differs from CI-Common's catalog, which is nested and
dot-namespaced (`common.actions.save`). This repo follows Hub's flat
`SCREAMING_SNAKE` instead, deliberately: Hub has not adopted the shared catalog
either, and `@companionintelligence/content` is still `private` with stub tooling.
Converging on it is a cross-repo migration, not something to do one repo at a time.

Key naming follows Hub: a domain prefix, then the specific action —
`SETTINGS_API_KEY_DELETE`, `CHAT_THREAD_NEW`, `MEMORY_VIEW_GALLERY`. Strings shared
across surfaces live under `COMMON_`.

**Do not add keys for user data.** A filename, a person's name, a colour preset, a
thread title — those are values, not copy, and go straight into `Tooltip.Content`:

```tsx
<Tooltip.Content>{media.title}</Tooltip.Content>
```

### Differences from Hub, and what is not done yet

Hub ships 30 locales and fetches them over HTTP, so it blocks first paint on an
async load. CI-Server ships only `en`, bundled, and initialises synchronously —
which is why `t()` resolves during the first render and inside tests without any
provider wrapper.

Only tooltip and icon-button strings are keyed today. The rest of the app's copy —
headings, buttons with visible labels, empty states, toasts — is still hardcoded
English. Internationalising it is a separate, whole-app migration; adding keys
piecemeal buys indirection without ever making the app translatable.

When a second locale lands, add `i18next-http-backend` with
`partialBundledLanguages: true` and serve the JSON from the API, matching
Hub's provider — `CI-Hub` (separate repo),
`packages/frontend/src/components/providers/i18n/i18n-provider.tsx`. Written as a
path rather than a link on purpose: a `../../../CI-Hub/…` relative link only
resolves for someone whose clone sits beside a CI-Hub clone, and is dead on GitHub.
