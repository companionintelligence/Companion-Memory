# Sources — the information architecture of "get my data in"

## The problem

Getting data into Companion had three destinations for one intention.

| Surface | What it was | How you found it |
|---|---|---|
| `/connections` | A grid of provider groups, and the line `Total Connections: 0` | Avatar menu → Connections |
| `/connect` | A gallery of things you *could* connect: browser extensions, Capture, one card that links to `/import`, and the service-integration grid | The `+` add menu, or the `+` button on `/connections` |
| `/import` | The archive wizard (Pick → Export → Sync) plus Inbox and History tabs | A single card on `/connect` |

Three problems compounded:

1. **The entry point was in the wrong menu.** `Connections` lived in the account
   dropdown — next to Settings, Theme and Log out. That is a menu people open to
   *change a setting*, not to *add data*. The primary sidebar carried Feed,
   Schedule, Memory, Chat, Saved Searches, Stats and Notes, and nothing about
   where any of it comes from.

2. **The first screen was a dead end.** A new user's `/connections` was a title
   and `Total Connections: 0`. The one screen guaranteed to be seen by everyone,
   exactly once, at the moment they have no idea what to do, said nothing about
   what to do.

3. **The split was invisible to the user.** `/connections` (what is connected),
   `/connect` (what you could connect) and `/import` (archives) are three
   implementation facts. The user has one question — *how do I get my stuff in?*
   — and a handful of real answers, none of which those three routes named.

## The decision

**One nav entry, one page, three paths.**

```
Power Rail → Sources → /sources
                      ├── /sources/connect   Services — accounts you sign into
                      ├── /sources/import    Import — the archive wizard + Inbox + History
                      └── /sources/devices   Devices — the extension and Capture, and what has registered
```

It began as two paths, with the extension and Capture as sections underneath
the connect path. That was wrong: it put the two sources nothing else can
substitute — what you read, and what you do on your own machine — behind a
scroll past a hundred services. A Takeout knows what you searched on Google and
nothing about the hour you spent reading the results; no export at all knows
what you did in a local application.

They share one path rather than taking two, because the appliance already
treats them as one thing: both register in `ci.devices`, where `device_type`
is `browser` alongside `laptop` and `desktop`, and both answer the same
question — which of my machines is feeding this, and is it still doing it.

Each path has the same shape: a header saying what it costs and what it gives,
then **what you already have, then what you could add** — connected accounts
above the service gallery, registered devices above the install gallery, run
history behind the import wizard. Every gallery is three cards to a row, full
width.

### Why "Sources" and not "Connect" or "Data"

The sidebar is a list of nouns — Feed, Memory, Notes, Stats. *Sources* fits, and
it names the thing rather than one of the two verbs. Calling the entry "Connect"
would have made the archive half feel like a sub-mode of connecting, which is
backwards: for most people a Google Takeout is the larger contribution to their
memory. "Data" is true of every page in the app.

### Why paths and not routes

Each path is addressable (`/sources/connect`, `/sources/import`,
`/sources/devices` — the three members of `SOURCE_PATHS`) so that redirects,
onboarding, and any deep link can land someone in the right place — but they
render inside **one page**, under one switch that is always on screen. The switch is not a tab
strip; it is a tile per path, each saying what that path is for and how long it
takes. Someone who lands on the wrong one can see the others without going
back.

`/sources` itself redirects to `/sources/connect`. Connecting is the
lower-effort path and the right default for a first visit; an export is
something you usually already have in hand and came here deliberately to add.

### Why the empty state is the switch, made loud

The switch is three tiles of one shape: an icon, a name, and what you have of
that path. It briefly carried the pitch too — `Effort` and `You get` on each
tile — which made every tile as tall as its longest sentence, gave the row three
different heights, and pushed the actual content below the fold.

The pitch lives at the top of each path's own content instead, as a
`PathHeader`: name, what it costs, what you get, in that order, on all three.
Moving between paths changes the answers and not the shape — and it is read at
the moment someone has already chosen to look, rather than shouted at them
three times at once.

The page carries **no heading and no standfirst**. The Power Rail entry is
labelled Sources and the tiles say what each path is for — a title plus an
introductory paragraph on top
of that was the third and fourth restatement of the same thing, and it pushed
the only actionable content on the screen below the fold. The tiles are the
first thing you see.

One component, two densities. The empty state cannot drift from the navigation,
because it *is* the navigation — and the screen a new user sees is the screen
that explains the only decision they have to make.

The distinction the three tiles draw is the one people actually get wrong (the
last two below are the two halves of the single **Devices** tile):

- **Connect a service** — a minute of work, and it keeps syncing. Gets you
  *from now on*, plus whatever recent history the API exposes.
- **Import an export** — you request it from the service, wait hours or days,
  then drop the file in. Gets you *your whole history*.
- **Add the extension** — install once, in the browser you use. Gets you what
  you read and search, which no export contains.
- **Run Companion Capture** — install once, on the machine you work on. Gets
  you screen context and app usage, which nothing else can.

Most people should do more than one, and the first-run tiles say so.

### What each source card claims

Every card across all three paths is the same component: a logo, a name, and a
list of what that source hands over. Those lists are keyed off the catalog's
`category`, not inferred from each guide's authored prose — a keyword matcher
over `whatImported` had GPX, a GPS track format, advertising "Listening,
Orders, Files" (from *"Track points"*, *"in route order"* and *"the file
includes them"*) while failing to mention Places, and 83 of the 100 catalog
entries have no `whatImported` at all to match against.

A card also says when that source was last used — but only what it can prove:

- **Connected services** date themselves from `syncState.lastSyncedAt`, which
  the sync orchestrator now writes when a sync job completes. It was already
  the convention (`findActiveConnections` reads exactly that key) but nothing
  had ever written it, so every reader got `null`.
- **Registered devices** carry their own `last_seen`, which is what the device
  registry is for. A per-device record count is *not* shown: nothing exposes
  one, and the honest options were to add a counting endpoint or to invent a
  number.
- **Import picker tiles** show a date drawn from finished runs, and only for an
  importer that belongs to exactly one catalog source — thirteen sources share
  four parsers, and marking Apple Calendar "imported" because a Google Calendar
  was is a claim about the wrong service. `partial` counts as imported: it is a
  terminal success state set whenever a single row failed, which is routine.
- **How much** a source contributed is deliberately *not* claimed. A run records
  one total for a whole archive, so a per-source figure could only be that total
  misattributed to each service inside it — and then summed again on a bundle
  tile, and doubled by a re-import whose rows were deduplicated away. The number
  is true of the *run*, so it is shown on the run, under History. What it counts
  is the push stage's `detail.pushed` — rows actually written — not its
  `processed`, which is a progress figure that also counts rows already present
  and rows that failed.

### What happened to `/connections`

The connected-accounts grid did not deserve a route. It is a status list, and it
belongs at the top of the connect path — above the gallery of what you could add
next — where it answers "what have I already done" in the place you go to do
more. The connection *detail* page keeps its own URL (`/connections/:id`); it is
a real object with real state, linked from the grid.

## Redirects

Old routes are kept as redirects, so bookmarks, docs and in-app links keep
working:

| Old | New |
|---|---|
| `/connect` | `/sources/connect` |
| `/connections` | `/sources/connect` |
| `/import` | `/sources/import` |
| `/connections/:id` | unchanged — connection detail |

## The import surface's own navigation

Inside `/sources/import`, the wizard's three steps **are** the navigation:
Pick · Export · Sync on the left, with Inbox and History as two toggle buttons
on the same row. There is no "Import" button, because the steps name that
surface already.

It is deliberately **not** a Radix `Tabs`. A tablist whose displayed panel has
no trigger is malformed — Radix labels every panel `aria-labelledby` its
trigger's id, so the wizard's panel pointed at an element that had been removed,
both remaining tabs reported `aria-selected="false"`, and roving focus landed on
Inbox and switched away from the wizard the moment a keyboard user reached the
row.

The wizard is also **hidden, never unmounted**. Everything it holds — the
services you picked, the export card you are on, the runs each card started —
is its own state, and a `Tabs` unmount threw all of it away: glancing at History
and clicking back to Export returned you to an Export step with nothing in it,
while the step row still showed Export as current. A persistent step row must
not sit above a component that dies whenever you use the row.

## Feature flag

`/import` was gated behind `import.page`, and a flag-gated route in this app is
not merely blocked when off — it is never registered, so it 404s. `/sources` is
**not** gated: the other three paths must always exist. Only the import path is.
With `import.page` off, the import tile is not rendered and `/sources/import`
normalises to `/sources/connect`, so nothing offers a path that leads nowhere.
This matches how onboarding already treats it —
`buildOnboardingStepKeys` only pushes `import-archives` when the flag is on.

## What was deliberately left alone

- **Onboarding.** `connect-source` and `import-archives` remain separate steps
  hosting the same `ServiceIntegrationsSection` and `ImportSurface` components.
  Onboarding is a linear script with its own stepper; the path switch is a
  navigation device for a page you return to, and it would be a second answer to
  "where am I" inside a flow that already has one.
- **`ImportSurface`.** `/sources/import` hosts the same surface `/import` did,
  with the same wizard, Inbox and History — reorganised only as described above.
- **Mobile.** The phone no longer has its own five-slot bottom bar to fight
  over: `MobileNavigation` renders the **same** Power Rail as the desktop, as a
  glass overlay drawer opened by the chevron in `MobileTopBar` or a swipe from
  the left edge. Sources is therefore the same single entry on both, and needs
  no separate mobile placement.
