# Third-party egress from Companion Memory

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Companion Memory's central claim is that your records stay on hardware you own. This document
records where that is *not* currently true, so the claim can be stated accurately and the gaps
closed deliberately.

This is **not an exhaustive audit.** It is what a targeted sweep of `backend/apps/api/src` and
`frontend/apps/web/src` turned up while correcting the product video's narration (see
[`video/README.md`](../../video/README.md)). User-initiated OAuth connectors — Google, Microsoft —
are out of scope: the user explicitly connects those and the data flow is the point of the feature.

> **Re-checked 2026-08-19.** Two of the four rows below have moved since this was written, both
> in the right direction: the Esri attribution is restored (#1), and the geocoder now defaults to
> CI-Portal rather than calling Google directly (#2). The sections are updated in place and the
> original finding is kept as history, because the reason each was a problem still applies to the
> next one like it.

## What leaves the appliance today

| # | Egress | Trigger | Gate | What is sent |
|---|---|---|---|---|
| 1 | **Esri** `server.arcgisonline.com` | Every map render | **None** | Tile coordinates — i.e. which part of the world your memories are in, at what zoom |
| 2 | **CI-Portal** `hub.ci.computer` (default), or **Google** `maps.googleapis.com` (`GEOCODING_PROVIDER=google`) | Forward/reverse geocode | Provider choice; Google additionally needs `GEOCODING_API_KEY` / `GOOGLE_MAPS_KEY` | Free-text location strings and coordinates **derived from user records** |
| 3 | **unpkg.com** | Opening `/api/graphiql` | None (route is unauthenticated-by-route, developer-facing) | Nothing user-specific; pulls React + GraphiQL from a CDN |
| 4 | **TMDB** `api.themoviedb.org` | `media.streamingAvailability` (`GetStreamingAvailabilityTool`) | `TMDB_API_KEY` | Media titles / queries |

Only **#1 fires unconditionally in a normal user session.** It is the one egress a fresh appliance
performs with no key, no connector and no configuration. #2 now fires on a default appliance too,
but to Portal rather than to a third party.

### #1 — Esri basemap, and the attribution (**fixed**)

[`frontend/apps/web/src/components/Map/Map.tsx:40-42`](../../frontend/apps/web/src/components/Map/Map.tsx)
hardcodes Esri's World Imagery tile service. It now carries
`attribution="Imagery © Esri, Maxar, Earthstar Geographics, and the GIS User Community"`, and the
`attributionControl={false}` prop on the `MapContainer` is gone, so Leaflet renders
`.leaflet-control-attribution` again. The source carries a comment pointing back at this document
explaining why it stays on.

The original finding, for the record: the control was switched off and the `<TileLayer>` carried no
`attribution` prop, so the product displayed **no basemap attribution at all**. That was two
problems at once — a **disclosure** one (the one place the UI would name a third party was off, so
a user had no way to learn the imagery is Esri's or that rendering it contacts Esri) and a **terms**
one (Esri's World Imagery service requires the credit; suppressing it is a licensing problem, not a
styling choice).

> This is also why removing the `.leaflet-control-attribution` mask from
> [`video/storyboard.json`](../../video/storyboard.json) changed no pixels at the time: the mask was
> hiding an element that did not then exist. Now that the control renders, the `memory-map-view`
> shot shows it — see the re-shoot note under Recommendation 1.

The egress itself is unchanged: rendering the map still contacts Esri on every tile.

### #2 — Geocoding: Portal by default, Google by opt-in

`config.geocoding.provider` (`GEOCODING_PROVIDER`) selects the bound provider, and it defaults to
**`portal`** (`backend/apps/api/config/default.json:227-232`).
[`selectGeocodeProviderClass`](../../backend/apps/api/src/domains/geocode/index.ts) binds
`PortalGeocodeProvider` unless the value is exactly `google`. Both classes are registered so either
can be selected without a module rebuild.

That closes the *original* finding — which was that
[`GoogleGeocodeProvider`](../../backend/apps/api/src/domains/geocode/services/GoogleGeocodeProvider.ts)
was the only provider bound to `GEOCODE_PROVIDER`, with no way to pick another, and that a missing
key merely warned rather than refused, making the geocoder *accidentally* opt-in: off because a key
was absent, not because anyone consented.

What it does **not** close is the egress. The default appliance now posts to CI-Portal
(`POST /api/geocode`, `POST /api/geocode/reverse` under `config.geocoding.portalBaseUrl`, default
`https://hub.ci.computer`) in batches of up to 100 items, each address truncated at 512 characters
to mirror Portal's own ceiling. The strings are still **derived from user records**; what changed is
who receives them and that the appliance no longer has to hold a provider key. State it that way in
any disclosure: geocoding leaves the box by default, to a first-party service.

Esri sends where you are looking; the geocoder is sent what your records say.

## Recommendation

**1. ~~Restore attribution~~ — done.** The `TileLayer` carries its `attribution` string and the
control renders. The remaining task is presentational: `memory-map-view` shows the control now, so
it must be re-shot in both viewports against the real-corpus stage
(`video/stage.real-corpus.sh`).

**2. Self-host the basemap (the real answer for #1).** Still open. An appliance that ships its own
tiles is the only version of this product where "opens on hardware you own" is unqualified.
Protomaps/PMTiles is the natural fit: a single-file archive served by the appliance, no tile server
to operate, and a planet-scale basemap is ~100 GB with far smaller regional extracts. On a 2 TB NVMe
box that is affordable; the storyboard's own hardware line (128 GB RAM / 2 TB NVMe) says so. Keep
Esri as an explicit, labelled fallback for users who want satellite imagery and accept the egress.

**3. Make geocoding consented, and give it a local option (partly done).**

- **A choice of provider — done.** `GEOCODING_PROVIDER` selects between Portal and Google, and
  Portal is the default, so the appliance no longer needs a Google key at all.
- **Consent, not config — still open.** The provider is a config value, not a user-facing setting.
  Nothing in the UI names Portal (or Google) as the recipient of location text, and nothing states
  what is sent. Choosing a default is not the same as obtaining consent.
- **A local provider — still open.** A Nominatim or Photon provider backed by a local extract would
  let the appliance resolve addresses without leaving at all. The `GEOCODE_PROVIDER` token and
  `selectGeocodeProviderClass` already make it a drop-in.

Until 2 and the open halves of 3 land, "your records never leave it" is not a claim the product can
carry, which is why the video no longer makes it.
