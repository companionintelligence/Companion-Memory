# Microsoft privacy export — dummy fixtures & verification notes

Dummy data modeled on the archive produced by <https://account.microsoft.com/privacy/download-data>
("Download your data" → "Create new archive"). All records are fabricated (contoso/fabrikam-style
names, `.example` hosts, Puget Sound coordinates); every file name, header, and field below is
labeled with how it was verified. Researched 2026-07-27.

Microsoft publishes **no per-file schema**. The only machine-verified schema anywhere public is a
real `SearchRequestsAndQuery` export a user uploaded to Scribd (doc 620789791, data dated Mar 2021),
whose header row is, verbatim:

```
DateTime,DeviceId,AccuracyRadius,Latitude,Longitude,Time,Title,Url,SearchTerms
```

Location columns appear even in a search export → the dashboard CSVs appear to share a **union
header across data types**, with most columns empty per type. `DateTime` is quoted
`M/D/YYYY h:mm:ss AM/PM +00:00` (UTC).

## Archive categories (verified current, 2024–2026)

Selectable in "Create new archive": **Location activity, Browse history, Search history,
Apps & Services usage** (quoted from a June 2024 MS Q&A thread; "App & service usage" also named in
Microsoft's Power Automate DSR doc, updated 2025-05). **Voice activity** and **Media activity** are
documented data types but effectively legacy (voice clips stopped being account-linked 2020-10-30;
media is Groove/Movies & TV era). **Cortana's Notebook** is retired (Cortana EOL 2023).
**Copilot activity** is on the dashboard but exports as separate CSVs, not inside the ZIP.

Microsoft support says the ZIP holds per-category **.JSON** files; a real 2022 export contained
**.csv** files (`BrowsingHistory.csv`, `ProductAndServiceUsage.csv`). Both eras exist in the wild,
so both fixture sets are provided.

## `microsoft-privacy-export-csv/` (CSV era, 2021+ — the current format)

Ground truth upgraded 2026-07-27 against a **real archive created 2026-07-24** (local file,
`Export-2607242242050921581118df1236.zip`): a flat ZIP (no folders) named
`Export-<digits+hex>.zip`, containing `ProductAndServiceUsage.csv` and
`SearchRequestsAndQuery.csv` (only categories with data appear). Timestamps are
double-quoted `MM/DD/YYYY HH:mm:ss +00:00` (24-hour UTC) — the 2021 Scribd-era
`M/D/YYYY h:mm:ss AM/PM +00:00` style is gone. Each category has its **own** header
(the union-header theory held only for search).

| File | Name | Columns |
| --- | --- | --- |
| `SearchRequestsAndQuery.csv` | VERIFIED (real 2026 archive + Scribd 620789791) | VERIFIED verbatim: `DateTime,DeviceId,AccuracyRadius,Latitude,Longitude,Time,Title,Url,SearchTerms`. Every row has `SearchTerms`; clicked-result rows also fill `Time` (click time), `Title`, `Url`; location columns observed empty. `AccuracyRadius` is in meters (Microsoft follows the W3C Geolocation convention regardless of device type) |
| `ProductAndServiceUsage.csv` | VERIFIED (real 2026 archive + MS Q&A 2377351) | VERIFIED verbatim: `DateTime,EndDateTime,DeviceId,Aggregation,AppName,AppPublisher`. Rows are per-day aggregates: `DateTime`=00:00:00, `EndDateTime`=23:59:59, `Aggregation`="Daily", `DeviceId` may be empty |
| `BrowsingHistory.csv` | VERIFIED (MS Q&A 2377351, 2022-05-26) | INFERRED — two candidate schemas, neither confirmed against a real file: (a) the search union header (clicked-page rows there carry Title/Url — the fixture uses this), and (b) an Edge-style header `DateTime,PageTitle,NavigatedUrl,DeviceType,Source,Latitude,Longitude,Accuracy` with ISO 8601 timestamps. The importer accepts both |
| `LocationActivity.csv` | INFERRED (matches category + naming pattern) | INFERRED — `DateTime,DeviceId,AccuracyRadius,Latitude,Longitude` (these exact columns are VERIFIED in the search header) |

## `microsoft-privacy-export-json/` (JSON era, per MS support docs)

| File | Name | Fields |
| --- | --- | --- |
| `ProductAndServiceUsage.json` | VERIFIED (windowsloop walkthrough) | INFERRED (`pages` wrapper, `EndDateTime`/`AppName`/`Publisher`) |
| `ContentConsumption.json` | VERIFIED (windowsloop; = "Media activity") | INFERRED |
| `SearchRequestsAndQuery.json` | name INFERRED from CSV twin | fields mirror the VERIFIED CSV columns |
| `BrowseHistory.json` | INFERRED ("Browse history" category) | INFERRED |
| `LocationActivity.json` | INFERRED | fields mirror the VERIFIED union-header location columns |
| `VoiceActivity.json` | INFERRED — least-verified file | INFERRED; dates deliberately pre-2020-10-30, after which voice clips are de-identified and never reach the dashboard |

## Copilot activity (separate dashboard export, NOT in the ZIP) — RESEARCH ONLY

> **No `microsoft-copilot-export/` directory exists here, and `microsoft_account.ts`
> has no Copilot branch** — a repo-wide grep for "copilot" under `datasources/`
> returns nothing (checked 2026-08-19). The table below is retained research, not
> a description of a fixture: it is what to build against if someone implements
> the Copilot export.

Privacy dashboard → Copilot → "Export all activity history" downloads a CSV (path + CSV format
VERIFIED from MS support 2acfee74). File names are undocumented (the ones below are invented).

| File | Columns |
| --- | --- |
| `CopilotAppsActivityHistory.csv` | `Timestamp,ClientApp,Prompt` — VERIFIED via thewindowsclub snippet (timestamp format inferred) |
| `CopilotM365ActivityHistory.csv` | `Author,ChatName,MessageContent,CreatedAt` — VERIFIED via same snippet |

## Importer support

`microsoft_account.ts` handles both eras: JSON archives (anchored on
`ProductAndServiceUsage.json`/`ContentConsumption.json`) and CSV archives (anchored on
`ProductAndServiceUsage.csv`/`SearchRequestsAndQuery.csv`), added 2026-07 after schema
verification against the real 2026 archive above. `ProductAndServiceUsage.*` is anchor-only:
it identifies the export but its rows (per-day "you used Bing/Edge that day" aggregates)
are deliberately not imported.

## Sources

- https://www.scribd.com/document/620789791/SearchRequestsAndQuery-1-2-1 (real export; header via /embeds/620789791/content)
- https://learn.microsoft.com/en-in/answers/questions/2377351/how-to-export-access-synced-browser-data (BrowsingHistory.csv, ProductAndServiceUsage.csv)
- https://learn.microsoft.com/en-us/answers/questions/5327934/im-not-able-to-use-the-privacy-dashboards-data-arc (category checkbox list, June 2024)
- https://learn.microsoft.com/en-us/power-automate/privacy-dsr-export-msa (flow + "App & service usage", updated 2025-05)
- https://support.microsoft.com/en-us/windows/open-your-activity-history-archive-9f09fbbc-78ed-3819-639a-46748587d042 (ZIP of per-type JSON)
- https://windowsloop.com/download-personal-data-microsoft-account/ (ProductAndServiceUsage.json, ContentConsumption.json)
- https://support.microsoft.com/en-us/topic/manage-your-copilot-activity-history-in-the-privacy-dashboard-2acfee74-d7c4-406d-b3fb-5f73da9272fc (Copilot CSV export)
- https://www.thewindowsclub.com/how-to-manage-copilot-activity-history (Copilot CSV columns)
- https://support.microsoft.com/en-us/topic/voice-data-on-the-privacy-dashboard-7494f5c4-2689-9b43-5636-6b491a2ca7b8 (voice de-identification cutoff)
- https://support.microsoft.com/en-ca/help/4468233 (Cortana end of support)
