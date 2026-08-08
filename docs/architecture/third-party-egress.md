# Third-party egress from Companion Memory

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**

Companion Memory's central claim is that your records stay on hardware you own. This document
records where that is *not* currently true, so the claim can be stated accurately and the gaps
closed deliberately.

This is **not an exhaustive audit.** It is what a targeted sweep of `backend/apps/api/src` and
`frontend/apps/web/src` turned up while correcting the product video's narration (see
[`video/README.md`](../../video/README.md)). User-initiated OAuth connectors — Google, Microsoft —
are out of scope: the user explicitly connects those and the data flow is the point of the feature.

## What leaves the appliance today

| # | Egress | Trigger | Gate | What is sent |
|---|---|---|---|---|
| 1 | **Esri** `server.arcgisonline.com` | Every map render | **None** | Tile coordinates — i.e. which part of the world your memories are in, at what zoom |
| 2 | **Google** `maps.googleapis.com` | Forward-geocode backfill | `GEOCODING_API_KEY` / `GOOGLE_MAPS_KEY` | Free-text location strings **derived from user records** |
| 3 | **unpkg.com** | Opening `/api/graphiql` | None (route is unauthenticated-by-route, developer-facing) | Nothing user-specific; pulls React + GraphiQL from a CDN |
| 4 | **TMDB** `api.themoviedb.org` | `GetStreamingAvailabilityTool` | `TMDB_API_KEY` | Media titles / queries |

Only **#1 fires unconditionally in a normal user session.** It is the one egress a fresh appliance
performs with no key, no connector and no configuration.

### #1 — Esri basemap, and the missing attribution

[`frontend/apps/web/src/components/Map/Map.tsx:35`](../../frontend/apps/web/src/components/Map/Map.tsx)
hardcodes Esri's World Imagery tile service. Two lines above it:

```tsx
attributionControl={false}
```

and the `<TileLayer>` carries no `attribution` prop. So Leaflet never constructs
`.leaflet-control-attribution`, and **the product displays no basemap attribution at all.**

That has two consequences:

- **Disclosure.** The one place the UI would name a third party is switched off. A user looking at
  the map has no way to learn the imagery is Esri's, or that rendering it contacts Esri.
- **Terms.** Esri's World Imagery service requires attribution. Suppressing it is not a styling
  choice; it is a licensing problem.

> This is also why removing the `.leaflet-control-attribution` mask from
> [`video/storyboard.json`](../../video/storyboard.json) changed no pixels: the mask was hiding an
> element that never existed. The committed `memory-map-view` shot shows a bare tile corner. The
> video was not concealing the disclosure — **the product has none to conceal.**

### #2 — Google geocoder

[`GoogleGeocodeProvider`](../../backend/apps/api/src/domains/geocode/services/GoogleGeocodeProvider.ts)
is the only provider bound to `GEOCODE_PROVIDER`
([`geocode/index.ts:42`](../../backend/apps/api/src/domains/geocode/index.ts)). There is no local
option and no way to pick one.

[`configuration.ts:351`](../../backend/apps/api/src/configuration.ts) **warns rather than refuses**
when no key is set, so a default appliance geocodes nothing. That makes the geocoder *accidentally*
opt-in — it is off because a key is missing, not because anyone consented. Supplying the key
silently begins forwarding location text drawn from user records to Google, with no user-visible
indication that it started.

Of the two, this is the one that sends **user data**. Esri sends where you are looking; Google is
sent what your records say.

## Recommendation

Both, in this order. They are independent and the first is much cheaper.

**1. Restore attribution now (small, unblocked).** Set `attributionControl` back on and give the
`TileLayer` its `attribution` string. This costs one commit, fixes the licensing exposure, and makes
the product self-disclosing so no caption has to do that job. It changes the map UI, so
`memory-map-view` must be re-shot in both viewports — and that shot can only be taken against the
real-corpus stage (`video/stage.real-corpus.sh`), which is why it is not bundled with the video fix.

**2. Self-host the basemap (the real answer for #1).** An appliance that ships its own tiles is the
only version of this product where "opens on hardware you own" is unqualified. Protomaps/PMTiles is
the natural fit: a single-file archive served by the appliance, no tile server to operate, and a
planet-scale basemap is ~100 GB with far smaller regional extracts. On a 2 TB NVMe box that is
affordable; the storyboard's own hardware line (128 GB RAM / 2 TB NVMe) says so. Keep Esri as an
explicit, labelled fallback for users who want satellite imagery and accept the egress.

**3. Make the geocoder opt-in, and give it a local option (the real answer for #2).** Two parts:

- **Consent, not config.** Promote the key check from a boot-time `console.warn` to a user-facing
  setting that names Google and states what is sent. Absence of a key is not consent.
- **A local provider.** The `GEOCODE_PROVIDER` token already makes this a drop-in: add a Nominatim
  or Photon provider backed by a local extract and let the appliance resolve addresses without
  leaving. Then Google becomes a quality upgrade the user chooses, not the only road.

Until #2 and #3 land, "your records never leave it" is not a claim the product can carry, which is
why the video no longer makes it.
