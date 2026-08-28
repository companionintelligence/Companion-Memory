# Selectors

> **Status:** ideation · **Updated:** 2026-08-11  
> Interactive catalog: **[selectors-catalog.html](selectors-catalog.html)**

Live sketches (click, drag, type) for prompting a person one decision at a time — Today /
Reflections / Onboarding / Memory confirmations — instead of open chat walls. (The two
surfaces were called Feed and Prompts when this was written; Feed is now embedded in
**Calendar** at `/calendar`, and Prompts is **Reflections** at `/self/reflections`.
Both moved again after this doc was written — `/today` and `/memory/reflections`
still work, as redirects.)

## Categories in the catalog

| # | Category | Examples |
|---|---|---|
| 1 | Binary | Yes/No, Keep/Discard, Approve/Edit, swipe |
| 2 | Choice | Single, multi, chips, A/B, searchable pick |
| 3 | Open text | One-line, paragraph, guided, voice, completion |
| 4 | Scale & rank | 1–5, slider, drag-rank |
| 5 | Time | Day chips, range rail, cadence, day-part, scrub |
| 6 | People | Person picker, attendees, role, “is this me?” |
| 7 | Place | Map pin, nearby venues, home/work/other |
| 8 | Media | Image pick, crop region, media scrub |
| 9 | Graph | Node tap, edge type, lasso, path |
| 10 | Data | Chart point, memory snippet, forecast slot, diff |
| 11 | Compound packs | Identify→relate→when, binary→open, conflict triad |

Time is the first catalog category with a code takeoff: Plan overdue reschedule shipped Plan-shaped copies (`WhenSelector`, iOS `PlanWhen`). Shared types (`RelativeDay`, `TimeScope`, `Cadence`) and what not to App-Intent are in [shared-time-selectors.plan.md](../architecture/shared-time-selectors.plan.md).

## View the page

```bash
cd docs/design && python3 -m http.server 8766
# → http://127.0.0.1:8766/selectors-catalog.html
```

Or open `selectors-catalog.html` directly in a browser.
