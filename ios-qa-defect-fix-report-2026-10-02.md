# iOS QA defect fixes, 2026-10-02: final accounting

All 66 defects from the iOS simulator QA run, one row each. Fix PRs are merged to `main` (final commit `0cf61d5cf`). Re-test results: 49 cases on the intermediate builds (`*@fixed`) and 5 on the final build (`*@final`) in the QA results directory.

| Outcome | Count |
|---|---:|
| Fixed, verified on a simulator | 54 |
| Fixed; unit/DB tests or the fixer's own harness only | 2 |
| Mitigated; remaining gap is model quality | 4 |
| Not a defect / not reproducible | 3 |
| Needs your decision | 2 |
| Not verifiable here | 1 |

## Per defect

| # | Sev | Case | PR | Outcome | Defect | Note |
|---:|---|---|---|---|---|---|
| 1 | P0 | LLM-01 | #2924 | Fixed, verified on a simulator | LocalLLM plugin not reachable from WebView on iOS | Settings > On-device model renders both cards on the shipped build (no local patch). |
| 2 | P1 | ETL-03 | #2926 | Fixed, verified on a simulator | Native upload fails: relative /api/import/uploads XHR throws invalid state in Capacitor |  |
| 3 | P1 | ETL-04 | #2926 | Fixed, verified on a simulator | Native upload fails for zip as well (same root cause as ETL-03) |  |
| 4 | P1 | LLM-22@patched | #2929 | Fixed, verified on a simulator | Privacy: attachment is uploaded to the appliance at attach time in 'Always answer on this phone' mode |  |
| 5 | P1 | LLM-23@patched | #2924 | Fixed, verified on a simulator | On-device model binds no tools: intent catalog fetched from /api/api/intents (404) | Catalogue 200 (old doubled path 404), 3 tools bound, tool call ledgered. Answer quality of the 0.6B model: see MEM-20. |
| 6 | P1 | MEM-06 | #2926 | Fixed, verified on a simulator | Media URLs are relative /static in the bundled iOS build, so thumbnails and drawer media fail |  |
| 7 | P1 | MEM-09 | #2926 | Fixed, verified on a simulator | Share link built in iOS app uses capacitor://localhost origin |  |
| 8 | P1 | PLAN-13 | #2931 | Fixed, verified on a simulator | Taps inside the chip Move dialog fall through to the calendar behind it |  |
| 9 | P1 | REFL-02 | #2928 | Fixed, verified on a simulator | Reflections prompt card, Catalogue, Your answers and Stats are dead on native (authToken null) |  |
| 10 | P1 | XB-02@patched | #2932 | Mitigated; remaining gap is model quality | Server chat claims actions it did not take (P5 add task, no write) | Plain write requests are refused in code and nothing is written (verified); other phrasings can still draw an invented 'done' from the 1B default model (A/B: 13/48). |
| 11 | P2 | CHAT-01 | #2932 | Fixed, verified on a simulator | Corpus question answered with fabricated JSON, no tool grounding | No fabricated JSON or tool syntax in any reply now; the 1B model still invents facts sometimes (see XB-02). |
| 12 | P2 | CHAT-01 | #2929 | Fixed, verified on a simulator | No visible way to reopen a past chat thread |  |
| 13 | P2 | CHAT-02 | #2932 | Fixed, verified on a simulator | No Stop control during buffered chat generation | Dev-origin only: vite answered the capacitor:// preflight without ACAO; fixed + verified; the appliance origin was never affected. |
| 14 | P2 | CHAT-04 | #2932 | Fixed, verified on a simulator | Model selection from the composer list does not take effect in the iOS shell |  |
| 15 | P2 | CHAT-05 | #2932 | Fixed, verified on a simulator | Raw UNTRUSTED_CONTENT>>> marker leaks into a chat answer |  |
| 16 | P2 | ETL-13 | #2927 | Needs your decision | Import doctor reports ok=false with 3 high findings | Genuine findings about the half-drained QA stack, not doctor bugs. Side finding fixed: Google Voice group recipients (#2934). |
| 17 | P2 | LLM-13@patched | #2929 | Fixed, verified on a simulator | No reachable 'New Thread' control on phone layout |  |
| 18 | P2 | MEM-05 | #2930 | Fixed, verified on a simulator | No visible Back control on entity full page |  |
| 19 | P2 | MEM-20@patched | #2924 | Fixed, verified on a simulator | On-device chat never invokes memory tools although intent catalog loads | knowledge_search now called and ledgered. The post-tool turn used to fail (45,756-byte result vs ~1,024-token window): fixed (#2938), turn completes; reply text of Qwen3 0.6B is still incoherent: needs a real iPhone (chip). |
| 20 | P2 | NOTE-03 | #2932 | Mitigated; remaining gap is model quality | Chat answer about a freshly indexed note is fabricated when the selected model has no tools | gemma3:1b: 2 of 3 answers quote the real note, 1 invents; tool-capable models (qwen3.5:9b) answer correctly. |
| 21 | P2 | PLAN-03 | #2931 | Fixed, verified on a simulator | Due date cannot be cleared on iOS |  |
| 22 | P2 | REFL-04 | #2925 | Fixed, verified on a simulator | Saving a Life details answer reloads the grid and jumps the page to the bottom, dropping the keyboard | Grid reload and page jump fixed. The keyboard still closes at autosave: by design per the case text (decision D5). |
| 23 | P2 | REFL-07 | #2925 | Not a defect / not reproducible | Free-text answer editor does not stop at 5,000 characters | Cap holds exactly for paste and typing; the original overshoot did not reproduce (likely lost keystrokes). Real server gap fixed: GraphQL answer mutations had no validation. |
| 24 | P2 | SET-02 | #2928 | Fixed, verified on a simulator | Autonomy page permanently disabled on API-key phone though /api/personalization/profile returns 200 |  |
| 25 | P2 | SET-02 | #2928 | Fixed, verified on a simulator | Export claims success on API-key phone while /api/account is credential-class |  |
| 26 | P2 | XB-02@patched | #2932 | Mitigated; remaining gap is model quality | Server chat answers corpus questions with fabricated content and wrong generic facts | Improved by #2932/#2947 (parroting 18->0 of 216) but gemma3:1b still gets cuisine/generic facts wrong sometimes; recommend a tool-capable default model. |
| 27 | P3 | AUTH-12 | #2930 | Fixed, verified on a simulator | No in-app feedback when Companion URL is bad |  |
| 28 | P3 | CHAT-01 | #2929 | Fixed; unit/DB tests or the fixer's own harness only | Thread title not set after ~9 min | Retry on an unusable title + 60-char fallback from the first message (#2946); DB spec + unit tests, not re-run on a device. |
| 29 | P3 | CHAT-03 | #2929 | Fixed, verified on a simulator | No new-chat after first message via drawer Chat row |  |
| 30 | P3 | CHAT-03 | #2929 | Fixed, verified on a simulator | No delete/rename for threads on phone | Delete works (native 204 bug #2943: row now disappears). RENAME needs a new endpoint: your decision. |
| 31 | P3 | CHAT-03 | #2929 | Fixed, verified on a simulator | Drawer thread rows show only 'Thread <id>' labels |  |
| 32 | P3 | CHAT-05 | #2932 | Mitigated; remaining gap is model quality | Small non-tool model answers starters with fabricated or tool-syntax text | Tool-requiring starters (incl. 'What is on Brief') are hidden when tools are off; remaining invention is the 1B model. |
| 33 | P3 | CHAT-06 | #2929 | Fixed, verified on a simulator | Attachment chip shows no filename ('Remove undefined') |  |
| 34 | P3 | CHAT-07 | #2928 | Fixed, verified on a simulator | Agents list empty on phone though server returns harness rows |  |
| 35 | P3 | ETL-01 | #2927 | Fixed, verified on a simulator | Import segment label truncated ('Imp...') on 402pt phone |  |
| 36 | P3 | ETL-02 | #2927 | Not verifiable here | Sticky Continue bar overlapped by iOS keyboard accessory bar when search focused | The headless Simulator has no software keyboard; fixers read the original as a hardware-keyboard artifact. Needs a device. |
| 37 | P3 | ETL-08 | #2927 | Fixed, verified on a simulator | Completed stages show in-progress phase text |  |
| 38 | P3 | ETL-08 | #2927 | Fixed, verified on a simulator | Duplicate source badges and raw ids in Found line |  |
| 39 | P3 | ETL-09 | #2927 | Fixed, verified on a simulator | Found list shows raw repeated ids; stale phase words on completed stages |  |
| 40 | P3 | ETL-13 | #2927 | Not a defect / not reproducible | Pick chip Watch 68.5k does not match DB youtube counts | Different measure: 68,533 watched videos = ci.content youtube media; QA compared with all youtube events. |
| 41 | P3 | ETL-16 | #2927 | Fixed, verified on a simulator | Signal (api_key provider) opens an OAuth Setup dialog |  |
| 42 | P3 | ETL-19 | #2927 | Fixed, verified on a simulator | Test connection result appears below the fold with no scroll |  |
| 43 | P3 | ETL-20 | #2927 | Fixed, verified on a simulator | Devices tab labels Safari 'Coming soon' while a bundled Safari extension and Settings > Safari steps exist |  |
| 44 | P3 | JOBS-03 | #2930 | Fixed, verified on a simulator | planning.fire_reminders has no taxonomy entry |  |
| 45 | P3 | JOBS-11 | #2930 | Fixed, verified on a simulator | Protected schedule rows show no visible lock or reason on touch |  |
| 46 | P3 | JOBS-20 | #2930 | Fixed, verified on a simulator | planning.fire_reminders and maintenance.person-stub-backfill-request missing from taxonomy.ts |  |
| 47 | P3 | LLM-09@patched | #2929 | Fixed, verified on a simulator | On-device status line truncated on phone |  |
| 48 | P3 | LLM-13@patched | #2929 | Fixed, verified on a simulator | Stale 'Answered on this phone' badge persists on empty new chat and on an old appliance thread |  |
| 49 | P3 | LLM-22@patched | #2929 | Fixed; unit/DB tests or the fixer's own harness only | Refused send leaves a phantom user message bubble | Unreachable in the UI once attaching is blocked in device mode; fixed by source + tests. |
| 50 | P3 | MEM-06 | #2926 | Fixed, verified on a simulator | gql file(id) returns Internal server error for an ORIGINAL image file id | Caller error (bare UUID); now a 400 BAD_USER_INPUT (verified). |
| 51 | P3 | MEM-07 | #2926 | Fixed, verified on a simulator | File Download navigates whole webview to a 404 page |  |
| 52 | P3 | MEM-08 | #2930 | Fixed, verified on a simulator | Empty-state overlaps expanded Starter searches list |  |
| 53 | P3 | MEM-15 | #2930 | Fixed, verified on a simulator | Custom range 'Specific time' inputs fall below the viewport |  |
| 54 | P3 | MEM-16 | #2930 | Fixed, verified on a simulator | Graph tab shows a raw error when the account has no self person |  |
| 55 | P3 | MEM-16 | #2930 | Needs your decision | 'From only' chip stays after the Who person is removed | Relabelled 'From anyone'/'To anyone'; whether to clear it on removing the last Who person is yours. |
| 56 | P3 | MEM-20@patched | #2924 | Not a defect / not reproducible | On-device model claims to have forgotten/remembered without any action | Not reproduced: remember/forget requests got honest replies and wrote nothing. |
| 57 | P3 | PLAN-01 | #2931 | Fixed, verified on a simulator | Plan tab strip clips 'Scheduled on calendar' and Done at 390pt |  |
| 58 | P3 | PLAN-02 | #2931 | Fixed, verified on a simulator | Long task title not clamped to 5 lines |  |
| 59 | P3 | PLAN-03 | #2931 | Fixed, verified on a simulator | Edit dialog caret opens at start of Title |  |
| 60 | P3 | PLAN-12 | #2931 | Fixed, verified on a simulator | New-event validation errors off screen at the Add button |  |
| 61 | P3 | PLAN-13 | #2931 | Fixed, verified on a simulator | Date picker opens automatically when the Move dialog opens |  |
| 62 | P3 | REFL-07 | #2925 | Fixed, verified on a simulator | Editing an answer sets answer_method 'user' while creating leaves it NULL | New rows record 'user' (verified); older NULL rows stay (decision). |
| 63 | P3 | REFL-08 | #2925 | Fixed, verified on a simulator | Provenance sheet does not dismiss on swipe-down |  |
| 64 | P3 | REFL-08 | #2925 | Fixed, verified on a simulator | Provenance dot is a 16x11 pt target |  |
| 65 | P3 | SET-02 | #2928 | Fixed, verified on a simulator | API Keys and MCP Servers show load-failure and empty-state together |  |
| 66 | P3 | XB-02@patched | #2932 | Fixed, verified on a simulator | Server-side forget request is silently ignored | Plain imperatives refused clearly and nothing changed (verified); other phrasings: model limit. |

## Merged PRs (24, each gated before merge: typecheck, prettier, eslint, oxlint, depcheck for backend, touched tests)

The 66 defects: #2924 on-device plugin, #2925 Life details, #2926 native URLs, #2927 import UI, #2928 native auth-gated screens, #2929 phone chat, #2930 memory/jobs/nav, #2931 planning, #2932 server chat grounding, #2933 on-device tool schemas.

Found by the re-test and fixed: #2934 Google Voice group recipients (446 of 4,096 outbound group texts had no recipient), #2935 comment correction, #2936 EventForm date/time fields on iOS, #2937 depcheck repair (a regression I merged in #2932; the gate now runs depcheck), #2938 on-device tool turn (failure reasons logged, leaked `<|...|>` tokens stripped, tool result bounded), #2939 lightbox safe area, #2940 text/PDF attachments in server chat, #2941 unsynced-imports banner, #2942 sheet header overflow + two saved-search P3s, #2943 native `Response` 204 bug (deletes of chats, API keys, MCP servers and the account), #2944 Life details cancel-scroll + Recent answers + sideways pan, #2945 Reflections category popup, #2946 chat titles + "This chat was deleted.", #2947 tool-less prompt rebalance.

## Found by the re-test and NOT fixed

- MEM-15: "Oldest first" with a When range does not start at the oldest item (pre-existing backend bug in the search resolver's timed path). Handed to you as a task chip.
- On-device answer quality after a tool call (Qwen3 0.6B, ~1,024-token window): the turn completes, the answer is incoherent. Needs a physical iPhone. Task chip.
- Tool-less chat on gemma3:1b can still echo injected context, invent personal facts, or promise a lookup (P2), and long replies can get junk auto-titles (P3). Model quality; see decision 1.
- NOTE-03: `knowledge_search` lists the in-flight chat thread first and shows the model only 2 of 25 hits (P3).
- Not exercised: PLAN-13 imported/recurring chips (no such rows on the account), the "This chat was deleted." path, REFL-13 to REFL-17 and REFL-24 (REFL-09 to REFL-12 ran), landscape.

## Decisions for you

1. **Default chat model.** gemma3:1b has no tools and is the compiled-in default. Recommend having the Hub install a small tool-capable model (for example qwen3.5:2b) and make it the default; more prompt tuning has diminishing returns.
2. **Thread rename.** No `PATCH /threads/:id` exists. Add it (plus inline rename) or rely on auto titles.
3. **MEM-16 chip.** Bare From/To is a supported filter; I relabelled it "From anyone". Clear it when the last Who person is removed instead?
4. **Import doctor.** `comms-missing-participants` and `pipeline-overdue-retries` have a non-zero floor on correct data. Recommend narrowing them (keep HIGH) after a drained-stack measurement.
5. **REFL-04 keyboard.** Free-text rows swap to the saved answer at autosave, so the keyboard closes. Recommend autosave on blur or keep the field mounted while focused.
6. **Old answers.** Rows created before #2925 have `answer_method` NULL; a one-off UPDATE after checking the distribution would let inference stop re-asking them.
7. **Uploads and downloads on the phone.** CapacitorHttp uploads have no progress events and base64-bridge each file; Download hands off to Safari. In-app save needs Share/Filesystem plugins.
8. **Accepted recommendations (tell me if you disagree).** Phone export/import and key/MCP/email-password management stay web-only; the on-device model does not offer `memory_remember` (no local-tier intent creates a Note); an app newer than its appliance (before #2653) reads as toolless.
9. **Google Voice.** List the members on inbound group messages too (about 8.3k rows, as iMessage does)? Rows imported before #2934 only gain recipients after a re-import.

## State left behind

- The cleanup script (`cleanup-handover.sh`) is still yours to run; the classifier blocked it twice.
- C2a left a lint-staged backup stash in the shared stash list; I did not drop it.
- Running: the QA `make dev` stack, six booted simulators, `log stream` processes. QA worktree `review-pr-2559-d7c9a7` is detached at `0cf61d5cf`; the old local LocalLLM patch is commit `0b92b0382` on `qa/local-llm-patch-2026-10-02`. My two verification worktrees `defect-fixes-integration` and `defect-fixes-integration-2` (many local `clau/verify-*` branches) are unpushed and safe to delete.
- QA data on account A: tasks "QA ...", events "QA lunch"/"QA lunch 2", Life details answers, saved search "QA T1 share test", tag `qa-tag`, three unsynced imports (do not Sync or Discard), ci.files rows from upload tests, chat threads from the tests, a self person (provisioned by the Autonomy save), the chat-model preference stored as `gemma3:1b` (originally NULL), D3's Qwen3 0.6B loaded.
- One disclosure: a fixer, stopping its preview server by port, killed two processes, one probably a Claude desktop helper that respawned.
