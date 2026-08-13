# Companion Mobile — Device-Data ETL: Store Compliance & Disclosure

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Per-source store-policy analysis for turning the phone into an **ETL source** for the
> user's own CI-Server appliance. Companion to [`DELIVERY.md`](./DELIVERY.md), which owns
> the *general* submission checklist; this file owns **everything that follows from
> reading device-native data**. Research pass: **2026-08-13**, against live Google Play
> Console Help / Play Policy Center and the Apple App Review Guidelines.
> **Re-verify at submission time — Play shipped policy changes on 2026-04-15 and
> 2026-07-15 with effective dates running into January 2027.**

---

## 0. TL;DR — read this before you build anything

Six of the fourteen sources on the wishlist **cannot ship through the public stores**, and
no amount of good framing changes that. They are excluded by policy *text*, not by
reviewer discretion:

| Source | Why it's dead |
|---|---|
| **SMS / MMS content** | Play requires the app be the **default SMS handler**. A memory app is not a messaging app. ⛔ |
| **Call log** | Play requires **default Phone/Assistant handler**. Same. ⛔ |
| **Notification listener as a message source** | Play's SMS policy explicitly bans *"alternative methods (including other permissions, APIs, or third-party sources) to derive data attributed to Call Log or SMS related permissions."* Notification scraping **is** the alternative method. ⛔ |
| **Accessibility-service screen capture** | Play's `IsAccessibilityTool` eligibility names *"assistants, monitoring apps"* as **explicitly not** accessibility tools. Non-tools may not use the API to *"autonomously initiate, plan, and execute actions or decisions."* An LLM memory agent is precisely that. ⛔ Also: **account termination**, not just app removal, is the stated penalty. |
| **App usage / screen time (iOS)** | Apple's Screen Time API is architecturally sealed: `DeviceActivityReport` runs in a sandboxed extension whose data **cannot be read by the host app** and cannot leave the device. There is no "get my usage stats" API to call. ⛔ **Impossible, not merely disallowed.** |
| **Installed-apps inventory (iOS)** | No public API. `LSApplicationQueriesSchemes` probes ≤50 *declared* schemes; that is not an inventory. Apple 5.1.2(iv) separately bans collecting *"information about which other apps are installed on a user's device."* ⛔ |

**The good news:** the *high-value* sources — health, calendar, location, motion, photos +
EXIF, files — are all shippable, and **four of them need no restricted-permission review at
all** if you use system pickers. The whole strategy below is built on that: get the ETL
pipeline into production behind zero declaration forms, then earn the harder permissions
one review at a time.

**The thing that will bite you first is not a permission.** It is that
`android:usesCleartextTraffic="true"` (still shipping, see `AndroidManifest.xml:9`) becomes
a *policy* problem the moment health/contacts/location flow over it — Play's User Data
policy requires *"modern cryptography (HTTPS)"* for personal and sensitive user data in
transit. Notes over plaintext LAN is a bad look; **health data over plaintext LAN is a
User Data policy violation.** See §9 🔴.

---

## 1. How to read this

Verdicts:

- ✅ **Grantable** — no declaration form, or a form a personal-memory app plausibly wins on the first try.
- ⚠️ **Hard** — declaration + human review + video demo. Winnable with the right framing; budget weeks and expect a round-trip.
- ⛔ **Effectively impossible** — the policy text excludes this app class. Do not build against it for public-store distribution. Alternatives in §5.

Severity + owner tags follow `DELIVERY.md`:
🔴 **P0** blocks submission · 🟠 **P1** fix before launch · 🟢 **P2** polish ·
**[code]** in-repo · **[acct]** needs a console/account/hosted asset · **[legal]** needs counsel, not engineering.

---

## 2. The matrix

> Ordered by *when you should attempt it*, not alphabetically. Phase column maps to §7.

| # | Source | Verdict | Android: permission → declaration | iOS: API → purpose string / entitlement | Data Safety / nutrition label | 3rd-party data | Phase |
|---|---|---|---|---|---|---|---|
| 1 | **Photos & videos — picker-selected** | ✅ / ✅ | Android **photo picker** (`ACTION_PICK_IMAGES`) → **no permission, no form** | `PHPickerViewController` → **no purpose string** | Photos and videos · Photos or Videos | 🟠 faces of others | **1** |
| 2 | **Photo EXIF / metadata only** | ✅ / ✅ | Picker URI + `ExifInterface`. Unredacted GPS from *MediaStore* needs `ACCESS_MEDIA_LOCATION`; from a **picked** item it comes with the file → no form | `loadFileRepresentation` on the picked item → **no purpose string**; `PHAsset.location` needs full-library auth | Precise location (if you keep GPS EXIF) | 🟠 co-location of others | **1** |
| 3 | **Files & documents — picker-selected** | ✅ / ✅ | **SAF** (`ACTION_OPEN_DOCUMENT` / `OPEN_DOCUMENT_TREE`) → **no permission, no form** | `UIDocumentPickerViewController` + security-scoped bookmarks → **no string** | Files and docs · Other User Content | 🟠 documents about others | **1** |
| 4 | **Share-in (share sheet / `ACTION_SEND`)** | ✅ / ✅ | Intent filter → **nothing** | Share Extension + App Group → **nothing** | Per payload type | 🟠 whatever the user shares | **1** |
| 5 | **Calendar** | ✅ / ✅ | `READ_CALENDAR` → **no restricted-permission form**; prominent disclosure required | EventKit → `NSCalendarsFullAccessUsageDescription` (iOS 17+; the old `NSCalendarsUsageDescription` is deprecated) | Calendar events · Other User Content | 🔴 **attendee names + emails** | **2** |
| 6 | **Motion / physical activity** | ✅ / ✅ | `ACTIVITY_RECOGNITION` → **no form** | `CMMotionActivityManager` / `CMPedometer` → `NSMotionUsageDescription` | Fitness info · Fitness | ✅ none | **2** |
| 7 | **Location — foreground / precise** | ⚠️ / ✅ | `ACCESS_FINE_LOCATION` (+`COARSE`) → **Permissions Declaration Form (location)**; from Android 17 the **location button** becomes the recommended minimum scope | `CLLocationManager` → `NSLocationWhenInUseUsageDescription` | Precise location | 🟠 implies who you were with | **2** |
| 8 | **Health & fitness** | ⚠️ / ⚠️ | Health Connect `android.permission.health.READ_*` → **Health apps declaration form** (+`READ_HEALTH_DATA_HISTORY` for >30 days) | HealthKit → `com.apple.developer.healthkit` entitlement + `NSHealthShareUsageDescription` (+`NSHealthUpdateUsageDescription` if writing) | Health info · Health | ✅ none | **3** |
| 9 | **Contacts** | ⚠️ / ⚠️ | `READ_CONTACTS` → **contacts declaration form from Sept 2026, mandatory 2027-01-27** for targetSdk 37+; **Contact Picker** is the minimum-scope alternative | `CNContactPickerViewController` (**no string**) vs `CNContactStore` (`NSContactsUsageDescription`) | Contacts · Contacts | 🔴🔴 **entire address book of non-consenting people** | **3 (picker only)** |
| 10 | **Location — background** | ⚠️ / ⚠️ | `ACCESS_BACKGROUND_LOCATION` + FGS `location` → **background-location declaration + video demo** + FGS-type declaration | `NSLocationAlwaysAndWhenInUseUsageDescription` + `UIBackgroundModes:location` + always-on blue indicator | Precise location | 🟠 | **4** |
| 11 | **Photos & videos — full library read** | ⚠️ / ⚠️ | `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` → **Photo & Video Permissions declaration**; broad access is for *"gallery apps"* | `PHPhotoLibrary` full auth → `NSPhotoLibraryUsageDescription`; Apple 5.1.1(iii) says *use the picker* | Photos and videos | 🟠 | **4 (only if 1+2 provably insufficient)** |
| 12 | **App usage / screen time** | ⚠️ / ⛔ | `PACKAGE_USAGE_STATS` (Settings special access, **no runtime prompt, no Play form found**) but *"inventory of other apps on the device"* is named personal & sensitive data | **No path.** `FamilyControls` entitlement is special-request; `DeviceActivityReport` data is sandboxed in-extension and cannot reach your app | App interactions · Installed apps | ✅ none | **4 — Android only** |
| 13 | **Installed-apps list** | ⛔ / ⛔ | `QUERY_ALL_PACKAGES` → form; permitted uses are *"device search, antivirus apps, file managers, and browsers"* only | No public API; 5.1.2(iv) bans it outright | Installed apps | ✅ | **never** |
| 14 | **All-files / whole-filesystem** | ⛔ / ⛔ | `MANAGE_EXTERNAL_STORAGE` → form; permitted uses are file managers, backup, AV, doc mgmt, on-device search, encryption, migration. **SAF is declared sufficient for "the vast majority of use cases."** | No equivalent; iOS has no filesystem read | Files and docs | 🟠 | **never** |
| 15 | **SMS / MMS** | ⛔ / ⛔ | `READ_SMS` etc. → default-SMS-handler only | No public API | Messages · Emails or Text Messages | 🔴🔴 | **never** |
| 16 | **Call log** | ⛔ / ⛔ | `READ_CALL_LOG` → default-Phone/Assistant-handler only | No public API | Messages / Contacts | 🔴🔴 | **never** |
| 17 | **Notification listener** | ⛔ / ⛔ | `BIND_NOTIFICATION_LISTENER_SERVICE` — banned as an SMS/call-log workaround by the anti-circumvention clause | No public API | Messages | 🔴🔴 | **never** |
| 18 | **Accessibility-service capture** | ⛔ / ⛔ | `BIND_ACCESSIBILITY_SERVICE` → declaration; ineligible for `IsAccessibilityTool`; autonomous action prohibited | No equivalent | — | 🔴🔴 | **never** |
| 19 | **Clipboard** | 🟠 / 🟠 | `ClipboardManager` reads only while focused (Android 10+); background clipboard monitoring is impossible | `UIPasteboard` general read triggers the iOS 16+ **paste prompt**; `UIPasteControl` for consent-free paste | Other user-generated content | 🟠 | **2, user-initiated paste only** |

---

## 3. Per-source detail

### 3.1 Health & fitness — the highest-value source, and it is winnable

**Android.** Health Connect is now the only supported path (`BODY_SENSORS` is being retired
in favour of granular `android.permission.health.*` from Android 16). Every read type is
its own permission. Two extras matter for ETL:

- `READ_HEALTH_DATA_HISTORY` — **without it, reads older than 30 days error out.** A memory
  vault backfilling a user's history absolutely needs this.
- `READ_HEALTH_DATA_IN_BACKGROUND` — required for anything that is not a foreground pull.
  Pair with an FGS `health` ("Health Data Sync") declaration if you sync in a service.

The **Health apps declaration form** gates all of it, and the approved use-case list is:
fitness/wellness/coaching, rewards, corporate wellness, medical care, human-subjects
research, health-integrated games.

> ⚠️ **"Personal memory vault" is not on that list.** Do not write that in the form. The
> hook that *is* in Google's own text is journaling — the FAQ defines the fitness & wellness
> case as *"applications or services allowing users to directly **journal**, report,
> monitor, and/or analyze their physical activity, sleep, mental well-being, nutrition,
> health measurements…"* **Declare `Fitness and wellness` and describe Companion as a
> personal health journal that correlates the user's own health metrics with their own
> notes and events.** That is true, and it is inside the policy's own words.

Hard limits to encode in product: no ads, ever; no use for credit, insurance, employment or
lending decisions; no third-party sharing without explicit informed consent. For a
self-hosted vault none of these are constraints in practice — but the **HBPE
behavioural-prediction engine** is where this gets non-obvious. Feeding health data into a
predictive model that the *user* consumes is "analyze"; anything that ever surfaces
inferences to anyone else is not.

**iOS.** `com.apple.developer.healthkit` entitlement, `NSHealthShareUsageDescription`,
plus `NSHealthUpdateUsageDescription` if you ever write back. HealthKit is available on
iPad, but confirm before shipping universal (see `DELIVERY.md` §1a iPad decision).

> 🔴 **The non-obvious rule everyone gets wrong.** Guideline **5.1.3(ii)**:
> *"Apps must not write false or inaccurate data into HealthKit … and **may not store
> personal health information in iCloud.**"* This is frequently mis-read as "HealthKit data
> may not leave the device." **It does not say that.** The prohibition is specific to
> **iCloud**. Syncing HealthKit data to a *user-owned server* is **not prohibited** —
> 5.1.3(i) governs it instead, and 5.1.3(i) bans advertising/marketing/use-based data
> mining, not storage or transmission. It also imposes an affirmative duty: *"You must
> disclose the specific health data that you are collecting from the device."*
>
> **So: syncing health to the user's Companion Core is permitted. The trap is accidental
> iCloud.** Two concrete ways this repo could violate 5.1.3(ii) without anyone deciding to:
> 1. The **on-device outbox** in `frontend/packages/capacitor-local-hub/` writes to the app
>    container. On iOS the app's `Documents/` directory is **included in iCloud Backup by
>    default** — a queued health payload sitting there is arguably PHI in iCloud.
>    **Mitigation (🔴 [code], for whoever owns the outbox): set
>    `URLResourceKey.isExcludedFromBackupKey = true` on the outbox store, or put it in
>    `Library/Application Support/` with the same exclusion, and never in a CloudKit
>    container or `NSUbiquitousContainer`.** *(This is my read of the rule applied to this
>    architecture, not a quoted Apple statement — but it is cheap insurance and Apple has
>    rejected on it.)*
> 2. Any future "backup my vault" feature must not offer iCloud as a destination for health
>    rows.

**Data Safety / label:** `Health and fitness → Health info` (Play); `Health & Fitness →
Health` (Apple). Purpose: App functionality. Not for tracking. Not shared.

**Third-party exposure:** none. This is *the* cleanest sensitive source — it is data about
the user only. Which is why it should be the **first hard permission you attempt.**

---

### 3.2 Calendar — easy permission, ugly third-party problem

No Play declaration form. `READ_CALENDAR` on Android; on iOS, note the **iOS 17 split**:
`NSCalendarsFullAccessUsageDescription` for read, `NSCalendarsWriteOnlyAccessUsageDescription`
for add-only. If you ship only the old `NSCalendarsUsageDescription` you will get an
authorization failure on modern iOS.

> 🔴 **[legal] What this uncovered:** calendar events are *not* single-subject data. A
> meeting record carries **attendee names and email addresses of people who never consented
> to your appliance.** This is the same category of problem as contacts, and it arrives
> through a permission nobody thinks twice about. Decide *before shipping* whether the
> extractor stores attendee identities or hashes/strips them. Recommendation: **ship
> attendee-stripping on by default with an explicit opt-in toggle**, and say so in the
> disclosure.

---

### 3.3 Contacts — technically grantable, ethically the hardest call in this document

**Android:** `READ_CONTACTS` is being pulled into the restricted-permission regime.
Announced 2026-04-15; declarations open in Play Console **September 2026**; mandatory
**2027-01-27** for apps targeting Android 17 (API 37)+. The rule: *"Apps that target Android
17 or later may only request the `READ_CONTACTS` permission if the Android Contact Picker
is not sufficient for your app to provide core functionality."* The qualifying use-case
list includes **"Personal Assistants"** and **"Backup/Restore"** — so a declaration is
plausibly winnable. That does not mean you should file it.

**iOS:** two very different postures. `CNContactPickerViewController` needs **no purpose
string at all**. `CNContactStore` needs `NSContactsUsageDescription` and puts you against:

- **5.1.1(iii):** *"Where possible, use the out-of-process picker or a share sheet rather
  than requesting full access to protected resources like Photos or Contacts."*
- **5.1.2(iv):** *"Do not use information from Contacts, Photos, or other APIs that access
  user data to **build a contact database for your own use** or for sale/distribution to
  third parties."*
- **5.1.1(viii):** *"Apps that compile personal information from any source that is not
  directly from the user or without the user's explicit consent … are not permitted."*

There is a real argument that a self-hosted vault builds the *user's* contact database, not
Lifescope's, and that 5.1.2(iv) targets developer-side harvesting. **That argument is
correct and it will not save you at first review**, because the reviewer sees "app reads
whole address book, uploads to a server, feeds an LLM" and has no reason to spend a rebuttal
cycle on architecture. Assume rejection on the first attempt if you request full-store access.

> 🔴 **[legal] The GDPR problem is genuinely unresolved, not a formality.** The household
> exemption (Art. 2(2)(c)) covers *"purely personal or household activity."* Case law
> (*Lindqvist*, *Ryneš*) narrows it when data is made accessible beyond the household or
> when processing extends into public space. A personal appliance in your own home is
> probably still household. **But three things in the current roadmap erode it:**
> (a) a **Lifescope-hosted demo/managed instance** puts a company in the processing chain;
> (b) **RAG + HBPE** run inference over other people's data, which is squarely "processing";
> (c) any future sharing/export surface breaks the household boundary outright.
> If any of those land, the user becomes a **controller for their contacts' data** and owes
> those contacts Art. 14 notice — which is unsatisfiable in practice.
>
> **Engineering recommendation:** ship the **picker only** — the user hand-picks the people
> they want remembered, per-contact, at the moment they want it. This is defensible under
> the household exemption, needs no declaration form on either store, needs no purpose
> string on iOS, and is exactly what Apple 5.1.1(iii) asks for. **Full address-book import
> should be a documented product decision signed off by counsel, not an engineering
> default.**

---

### 3.4 Location — foreground is routine, background is a project

Foreground precise location is a normal runtime permission with a Play location declaration.
Background is a different animal:

- `ACCESS_BACKGROUND_LOCATION` requires the **background-location declaration form** with a
  **video** that shows *"the location-based feature being used in your app"* **and** *"the
  prominent disclosure dialog that gets shown to users."*
- The form asks you to describe **one** background-location feature that *"can't be
  implemented without this access"* and that *"should be related to the main purpose of your
  app."*
- Separately, Android 14+ requires a **foreground-service type declaration** (`location`)
  with its own description + video.
- From Android 17, Play recommends the **location button** (`onlyForLocationButton`) as
  minimum scope for one-time precise location (effective 2027-01-27).

> ⚠️ **Honest read:** "build a passive timeline of everywhere I go" is a *good* feature and a
> *bad declaration*. Google's reviewers see continuous background tracking with no visible
> user-facing purpose. The framing that has a chance is a **named, visible feature** —
> e.g. "Place Timeline: automatically attaches the place to each memory you capture, and
> shows a map of your day" — with a UI the video can actually show. **Budget two rejection
> cycles.** Ship foreground-only first (Phase 2) so a background rejection cannot block the
> rest of the release.

Apple: `NSLocationWhenInUseUsageDescription` → `NSLocationAlwaysAndWhenInUseUsageDescription`
+ `UIBackgroundModes: location`. No declaration form, but 5.1.5 requires location be
*"directly relevant to the features and services provided by the app"* and the persistent
blue status indicator makes always-on tracking user-visible by design.

---

### 3.5 Photos — the picker is the whole strategy

This is the single biggest "free win" in the matrix, and `DELIVERY.md` §1d already flags the
trap in the other direction.

| | Picker | Broad read |
|---|---|---|
| Android | `ACTION_PICK_IMAGES` — **no permission, no declaration, no policy exposure** | `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` → Photo & Video Permissions declaration; permitted only where the picker is *"not sufficient … to provide core functionality"*, essentially **gallery apps** |
| iOS | `PHPickerViewController` — **no purpose string** | full `PHPhotoLibrary` auth → `NSPhotoLibraryUsageDescription`, against 5.1.1(iii)'s explicit preference for the picker |

**EXIF specifically.** You do not need library access to get metadata. A picked item gives
you the file; `ExifInterface` (Android) / `loadFileRepresentation` (iOS) reads EXIF from it,
GPS included. `ACCESS_MEDIA_LOCATION` is only needed for **unredacted EXIF read out of
MediaStore**, i.e. the broad-access path — and even then Android notes *"there is no
guarantee that your app has access to unredacted EXIF metadata."*

> 💡 **The metadata-only ETL case is much stronger than the pixels case.** If the product goal
> is "know that I was at the beach on the 4th," you want EXIF timestamps + GPS + camera
> model, not 40 GB of JPEGs. **Ship a metadata-only extractor over the picker.** It needs
> zero declarations, produces a fraction of the sync volume, and is a materially easier
> privacy story. Note also: `READ_MEDIA_VISUAL_USER_SELECTED` (Android 14 partial access) is
> a middle tier if you later need repeat access to a user-chosen subset.

> ⚠️ Current iOS state: only `NSPhotoLibraryAddUsageDescription` exists in `Info.plist`. The
> picker path needs **no** new key. If you ever add full read, you need
> `NSPhotoLibraryUsageDescription` **and** a re-filed nutrition label.

---

### 3.6 App usage / screen time — Android-only, and only just

**Android.** `PACKAGE_USAGE_STATS` is a *special app access* granted through Settings, not a
runtime prompt. I found **no dedicated Play declaration form** for it. That is not the same
as "unregulated": the User Data policy names *"inventory of other apps on the device"* as
**personal and sensitive user data**, so it inherits the full prominent-disclosure + consent
+ Data Safety obligations. Data Safety: `App activity → App interactions` and
`Installed apps`.

> ⚠️ **Honest read:** technically grantable, reputationally expensive. An app that ships your
> app-usage log to a server is a "monitoring app" in reviewer vocabulary — and "monitoring
> apps" is the exact phrase Play uses to describe things that are *not* accessibility tools.
> Expect elevated scrutiny and a real chance of a manual review escalation. **Attempt it
> last, in its own release, after the account has a clean history.**

**iOS.** Not merely disallowed — **architecturally impossible.** `FamilyControls` is a
special-request entitlement, and even with it, `DeviceActivityReport` renders inside a
sandboxed extension specifically designed so the host app *cannot read the underlying
activity data*. Apple built it that way on purpose. **There is no iOS app-usage ETL. Stop
looking.**

---

### 3.7 The dead sources, stated plainly

**SMS and call log.** The policy is unambiguous: *"It must be actively registered as the
default Phone or Assistant handler on the device."* Companion is not a dialer and not an SMS
app. There is no "personal archive" exception, and the temporary-exception list (caller ID,
backup/restore, connected-device companions, device automation, enterprise CRM, in-vehicle,
financial SMS) is scoped to apps whose *core purpose* is that thing. A memory app filing for
"backup and restore" of SMS would be claiming to be a backup app; Play would then expect the
entire product to be a backup app.

**Can a memory app EVER get these approved? No.** Not with better wording, not with a
better video, not by describing the vault as a backup. The gate is *default-handler
registration*, which is a user-visible OS role you would have to actually take over.

**And you cannot route around it.** The same policy: *"You may not use alternative methods
(including other permissions, APIs, or third-party sources) to derive data attributed to
Call Log or SMS related permissions."* That clause is why the notification listener is dead
too — reading SMS notifications is deriving SMS data by an alternative method. It is an
enumerated violation, not a grey area.

**Accessibility service.** `IsAccessibilityTool` is *"only [for] services designed to help
people with disabilities access their devices."* The ineligible examples list includes
**"assistants, monitoring apps."* For non-tools: *"Any use of the Accessibility API that
enables an app to autonomously initiate, plan, and execute actions or decisions is strictly
prohibited."* An LLM agent reading the screen to build memory is the textbook case. Penalty
language is *"suspension of your app and/or **termination of your developer account**."*
**Do not prototype this in a build that shares a developer account with the store listing.**

**`QUERY_ALL_PACKAGES`.** Permitted uses are *"device search, antivirus apps, file managers,
and browsers."* Use scoped `<queries>` if you ever need to detect a specific companion app.

**`MANAGE_EXTERNAL_STORAGE`.** Google states SAF *"supports the vast majority of use cases"*
and requires you to prove it doesn't. A memory app importing user-chosen documents is the
paradigm SAF case. You will lose this declaration.

---

## 4. The self-hosted Data Safety question — and the answer is different on each store

This is the genuinely novel problem, and the two stores resolve it **differently**, which is
why the field is inconsistent.

**Play's definition is destination-agnostic.** *"'Collect' means transmitting data from your
app off a user's device."* Full stop — no clause about who owns the destination. The only
carve-outs are **on-device-only**, **end-to-end encrypted** (*"unreadable by you or anyone
other than the sender and recipient"*), and **ephemeral in-memory** processing.
→ **Companion syncing to the user's appliance IS collection under Play's rules.**

**Apple's definition is developer-access-based.** *"'Collect' refers to transmitting data off
the device in a way that **allows you and/or your third-party partners to access it** for a
period longer than what is necessary to service the transmitted request in real time."*
→ For a pure self-host with no Lifescope instance, there is a **defensible reading that
nothing is collected** — which is exactly what the existing `PrivacyInfo.xcprivacy` comment
argues. **But `DELIVERY.md` §1b requires a Lifescope-hosted demo server, and data flowing to
that instance IS developer-accessible.** The moment the demo server exists, the clean
"nothing collected" answer stops being true for the shipped binary.

### What comparable self-hosted apps actually answered

Real Play Data Safety declarations, read 2026-08-13:

| App | Declares | Read |
|---|---|---|
| **Nextcloud** (`com.nextcloud.client`) | *"doesn't collect user data"* / *"doesn't share"* | **Aggressive.** Files demonstrably leave the device. Defensible only if you read "collect" as "the developer collects." Not the position I'd defend for a health-data app. |
| **Home Assistant** (`io.homeassistant.companion.android`) | Collects **Device or other IDs** only; no sharing; **encrypted in transit: yes**; deletion path: yes | **Inconsistent.** Their own docs describe Sentry crash reporting in the full flavour, yet crash logs aren't declared. Also declares TLS while HA is routinely reached over LAN http — the same problem this repo has. |
| **Immich** (`app.alextran.immich`) | Collects **Photos and Videos** + **Device or other IDs**, both optional, purpose *App functionality*; no sharing; encrypted in transit | **Correct, and the model to copy.** Immich is architecturally identical to Companion — user-owned server, no vendor cloud — and it still declares the payload as collected. |
| **Bitwarden** (`com.x8bit.bitwarden`) | Collects email, user IDs, files, photos, audio; **shares crash logs for analytics** | Shows what honest declaration looks like even for a zero-knowledge product. |

**Precedent verdict: follow Immich.** Declaring collection is not an admission that Lifescope
sees the data — Play's form has no "user-owned destination" checkbox, and the *sharing*
question is where you get to say "no third parties." Under-declaring is the failure mode
that gets apps pulled; over-declaring costs nothing but a paragraph in the listing.

---

## 5. Not shippable via public stores — and what to do instead

| Source | Alternative that actually works |
|---|---|
| **SMS / MMS** | **On-device-only.** Sideloaded/unlisted companion APK; or user-driven export (Android's own backup, or a share-sheet export the user performs) ingested as a file via §3.5's picker path. Nothing automatic. |
| **Call log** | Same. There is no legitimate automated path. |
| **Notification listener** | **Sideload / Play "unlisted" or private (managed Google Play) distribution** — still policy-bound, so treat as sideload-only. **Better answer: on-device-only summarization** that never syncs raw notification text, which keeps you inside Play's on-device carve-out — but this is still an SMS-derivation risk if notifications include messages. Recommend **not building it at all** for the store binary. |
| **Accessibility capture** | None. Do not ship, do not sideload from the store developer account. If you need screen-context, use **user-initiated screenshots via the share sheet** (§3.4) — the user chooses, every time. |
| **App usage (iOS)** | None. Ship the Android-only feature and be explicit in the UI that iOS cannot provide it. |
| **Installed apps** | Scoped `<queries>` for specific interop targets only. Drop the inventory feature. |
| **All-files access** | SAF folder grant (`ACTION_OPEN_DOCUMENT_TREE`) — persistable, recursive, no declaration. Covers "watch my Documents folder" almost entirely. |
| **Full photo library** | Picker + `READ_MEDIA_VISUAL_USER_SELECTED` (Android 14+) for repeat access to a user-chosen subset. |

> **On the "just sideload it" instinct:** a second, permission-heavy APK distributed outside
> Play is legally fine and technically easy — but it **must not share the Play developer
> account's signing/listing identity for anything Play would consider a policy circumvention
> pattern**, and Apple has no sideload analogue outside enterprise (which `DELIVERY.md` §2
> already rules out for a public product). Treat sideload as a **power-user Android-only
> escape hatch**, never as the plan.

---

## 6. Exact Data Safety / nutrition-label answers

### 6.1 Google Play — Data Safety form

Answer **"Yes, this app collects or shares user data."** Then, per phase:

| Category → type | Collected | Shared | Purpose | Optional? | Ephemeral |
|---|---|---|---|---|---|
| Personal info → Email address, User IDs | ✅ | ❌ | App functionality, Account management | Required | No |
| Photos and videos → Photos, Videos | ✅ (P1) | ❌ | App functionality | **Optional** | No |
| Files and docs | ✅ (P1) | ❌ | App functionality | **Optional** | No |
| Calendar → Calendar events | ✅ (P2) | ❌ | App functionality | **Optional** | No |
| Location → Precise location | ✅ (P2) | ❌ | App functionality | **Optional** | No |
| Health and fitness → Fitness info | ✅ (P2, motion) | ❌ | App functionality | **Optional** | No |
| Health and fitness → Health info | ✅ (P3) | ❌ | App functionality | **Optional** | No |
| Contacts → Contacts | ✅ (P3) | ❌ | App functionality | **Optional** | No |
| App activity → App interactions, Installed apps | ✅ (P4, Android) | ❌ | App functionality | **Optional** | No |
| Audio → Voice recordings; Messages → Other in-app messages | ✅ | ❌ | App functionality | **Optional** | No |

Security section:

- **"Data is encrypted in transit"** — 🔴 **You cannot answer Yes today.** `usesCleartextTraffic="true"` permits plaintext to a LAN appliance. Options: (a) answer **No** and disclose accurately, (b) fix §9 first and answer **Yes**. **Recommendation: fix, then Yes.** Answering "Yes" while shipping app-wide cleartext is a false declaration.
- **"Users can request data deletion"** — **Yes**, but only once the purge job in `DELIVERY.md` §1a exists. Until then the honest answer is that access is revoked, not that data is deleted. **Do not overstate.**
- **Data shared with third parties** — **No**, across the board. This is the strong claim and it is true.

**Health apps declaration:** 🔴 **[acct] you must file this even today.** Google requires the
form from *every* developer with a published app — including closed and open testing tracks
— and apps with no health features must affirmatively certify that. **This is a live gap in
`DELIVERY.md` §1c that predates any device-data work.**

### 6.2 Apple — App Privacy nutrition label

Declare, do not rely on the "nothing collected" reading:

| Data type | Linked to You | Used for Tracking | Purpose |
|---|---|---|---|
| Contact Info → Email Address | ✅ Linked | ❌ | App Functionality |
| Identifiers → User ID | ✅ Linked | ❌ | App Functionality |
| User Content → Photos or Videos, Audio Data, Other User Content | ✅ Linked | ❌ | App Functionality |
| Health & Fitness → Health, Fitness | ✅ Linked | ❌ | App Functionality |
| Location → Precise Location | ✅ Linked | ❌ | App Functionality |
| Contacts → Contacts (**only if** full-store access ships) | ✅ Linked | ❌ | App Functionality |

- **Tracking: No.** No ad SDKs, no analytics SDKs, no data brokers, no third-party linkage → the definition is not met. No ATT prompt needed.
- The **"optional disclosure"** exception does not rescue you: it requires collection be *"infrequent … not part of the app's primary functionality"* — memory capture **is** the primary functionality.
- 🟠 **[code]** Reconcile `PrivacyInfo.xcprivacy`. Its `NSPrivacyCollectedDataTypes` is empty with a comment explaining the self-hosted argument. That argument is defensible for the *manifest* (which is about developer/SDK collection) while the *label* declares transmitted categories — but the two artifacts pointing opposite directions invites a reviewer question. **At minimum, update the comment to name the demo server as the reason the label and the manifest differ.** Revisit if App Review ever queries the mismatch.

### 6.3 Review notes — say this, once, clearly

> Companion is a client for a server the user owns and operates. Device data selected by the
> user is transmitted only to that user-controlled appliance; Lifescope operates no cloud
> service and has no access to it. The demo credentials below point at a seeded,
> throwaway Lifescope-hosted instance provided solely for review; production users connect
> to their own hardware. No data is shared with third parties, no advertising or analytics
> SDKs are present, and no data is used for tracking.

---

## 7. Phased submission sequence — never put a risky permission in review #1

The organising principle: **a rejection on permission N must not block the release of
features 1…N-1.** Each phase is its own store release with its own declarations.

### Phase 0 — the current binary. **Ship nothing new.**
Close the `DELIVERY.md` 🔴 P0s (demo server, signing, deletion purge, privacy policy, EU
trader, nutrition label, **health apps declaration**). Prove the self-hosted review path
works with only camera/mic/notifications. **Adding a single device-data permission here
risks the one review you cannot afford to fail.**

### Phase 1 — "Zero-declaration ETL". *No new permissions at all.*
Photo picker + EXIF · document picker / SAF tree · share-in target.
**Declaration forms required: none. Purpose strings required: none. Manifest permissions
added: none.** This puts the outbox → appliance ETL pipeline in production and generates
the real-world usage evidence that later declarations will need. **This is the single most
important strategic move in this document.**

### Phase 2 — "Ambient context". Runtime permissions, one declaration.
Calendar (read, attendees stripped by default) · motion/activity · **foreground** location ·
user-initiated clipboard capture.
New: `READ_CALENDAR`, `ACTIVITY_RECOGNITION`, `ACCESS_FINE/COARSE_LOCATION`;
`NSCalendarsFullAccessUsageDescription`, `NSMotionUsageDescription`,
`NSLocationWhenInUseUsageDescription`. One Play location declaration. **Re-file both stores'
privacy answers.**

### Phase 3 — "Health". The first genuinely hard review, taken alone.
Health Connect + HealthKit, `READ_HEALTH_DATA_HISTORY`, contacts **via picker only**.
New: Play Health apps declaration with `Fitness and wellness` framing; HealthKit
entitlement + `NSHealthShareUsageDescription`. **Ship this in a release that contains
nothing else you care about**, so a health rejection doesn't hold hostage anything shipped
in Phases 1–2.

### Phase 4 — "Ambient background". Expect rejections; that's the plan.
Background location (declaration + video + FGS-type declaration) · background health reads ·
Android app-usage · full-library photo read **only if** Phase 1 provably fell short.
Each of these gets **its own release**. Never bundle two video-demo declarations.

### Never
SMS · call log · notification listener · accessibility capture · `QUERY_ALL_PACKAGES` ·
`MANAGE_EXTERNAL_STORAGE`.

---

## 8. Prominent disclosure — the UX you must build, not just the copy

Play requires this for every sensitive source, and it is a **rejection cause in its own
right**, independent of whether the permission is granted. Requirements, from the policy:

- **In the app itself**, immediately before the runtime permission prompt — *"cannot only be
  in the app description or on a website"*, and *cannot* be satisfied by the privacy policy.
- Must appear during normal use **without navigating a menu**.
- Must answer four things: **why** the capability is needed, **what** data it collects,
  **how** that data is used, in language *"a 13-year-old"* can read.
- Consent must be **affirmative** — a tap on a button reading **"Agree"** (Play explicitly
  calls out *"Allow access"* and *"Got it"* as insufficient), never implied by navigation,
  never auto-dismissing.
- Must offer a **decline** path, and the app must **degrade gracefully** — disable the
  feature, keep the app usable.
- Must be **separate** from unrelated disclosures. One screen per capability, not a combined
  "we collect stuff" wall.
- Must **not** mimic an Android system dialog; style it like the app.

🟠 **[code]** Build **one reusable disclosure component** in `@ci/fe-web` parameterised by
source, and record consent per-source in the outbox schema. Every phase reuses it. Every
declaration form also wants a **video showing this screen**, both the consent and the
non-consent path — so make it screen-recordable and deterministic.

🟠 **[code]** Apple 5.1.2(i) has a rule with teeth here too: *"Your app may not require users
to enable system functionalities … in order to access functionality, content, [or] use the
app."* **No device-data permission may gate app usage.** A "grant all of these to continue"
onboarding wall is a rejection.

---

## 9. Cross-cutting blockers this analysis surfaced

- 🔴 **[code] Cleartext vs. sensitive data.** Play's User Data policy requires personal and
  sensitive user data be protected with *"modern cryptography (HTTPS)"* in transit. The app
  ships app-wide `usesCleartextTraffic="true"` (`AndroidManifest.xml:9`) so LAN appliances
  work. `DELIVERY.md` §1a deliberately deferred narrowing this. **That deferral expires the
  moment health/contacts/location flow.** Options, in order of preference: (a) require
  HTTPS for the appliance and ship the pairing flow with a trust-on-first-use cert (QR
  pairing is already on the roadmap — fold the cert into it); (b) `networkSecurityConfig`
  with cleartext permitted only for RFC1918/CGNAT/tailnet ranges; (c) block sensitive
  sources entirely when the resolved `apiBase` is `http:`. **(c) is cheap, honest, and
  shippable now** — and it makes the Data Safety "encrypted in transit: Yes" answer true.

- 🔴 **[acct] Health apps declaration is already overdue.** Required of *every* developer
  with a published app, including testing tracks, even with zero health features. Not in
  `DELIVERY.md`'s checklist. Add it to Phase 0.

- 🔴 **[code] Deletion promise vs. device data.** The soft-delete + `purge_after` design
  described in `DELIVERY.md` §1a is unfinished. Device data makes it worse: health, location
  and contacts rows are precisely what a deletion request is *about*. **The purge job is a
  hard prerequisite for Phase 3**, not a nice-to-have.

- 🟠 **[code] The outbox is a compliance surface.** Data queued on-device and never
  transmitted is **not "collected"** under either store's definition. That means a
  **local-only mode is a genuine product feature with a genuine compliance dividend** — and
  it also means the outbox must be encrypted at rest, excluded from iCloud/adb backup
  (`allowBackup="false"` already handles Android), and must **drop, not retain, payloads for
  sources whose consent was revoked.**

- 🟠 **[legal] Third-party data has no engineering fix.** Contacts, calendar attendees,
  photos of other people, shared documents. The mitigations that exist are product
  decisions: picker-only contacts, attendee stripping, face-blind photo metadata, and a
  documented retention/erasure path. **Get counsel's position before Phase 3**, particularly
  on whether a Lifescope-hosted demo or managed instance makes Lifescope a processor for
  third-party personal data.

- 🟢 **[code] iPad + HealthKit.** `DELIVERY.md` decided universal. Confirm HealthKit
  availability and behaviour on iPad before declaring the entitlement, and do not add
  HealthKit to `UIRequiredDeviceCapabilities` (it would silently drop iPad).

---

## 10. What this uncovered

1. **The picker path is not a compromise — it's the better product.** Metadata-only photo
   ETL over the system picker needs zero declarations on both stores, syncs a fraction of
   the bytes, and answers the actual product question ("where was I, when") better than
   hoarding pixels does. The "sovereignty" pitch and the low-permission path point the same
   direction, which almost never happens.

2. **The HealthKit iCloud rule is narrower than its reputation.** 5.1.3(ii) bans **iCloud**,
   not servers. Health → user-owned appliance is permitted. The real exposure is the
   *accidental* iCloud path through the on-device outbox sitting in an iCloud-backed
   container — a bug, not a policy decision, and one nobody would have gone looking for.

3. **Play and Apple disagree about what "collected" means**, and the disagreement is exactly
   at the self-hosted seam: Play says *off the device*, Apple says *accessible to you*. That
   asymmetry — not sloppiness — is why Nextcloud says "no data collected" and Immich says
   "photos and videos collected." **Immich is the better precedent** and it is the closer
   architectural match.

4. **The demo server that `DELIVERY.md` identifies as the review unlock is also what breaks
   the cleanest privacy answer.** Once a Lifescope instance exists, "the developer cannot
   access user data" stops being unconditionally true for the shipped binary. That trade is
   still worth making — but the nutrition label and the privacy policy have to be written
   for the world *with* the demo server, not the idealised one.

5. **`usesCleartextTraffic` graduates from a code-quality item to a policy violation.** It
   was a defensible deferral for notes. It is not defensible for health data. This is the
   one item in this document that blocks a phase and has nothing to do with permissions.

6. **The anti-circumvention clause is the reason four features die at once.** SMS, call log,
   notification listener and accessibility capture are not four separate judgement calls —
   they collapse into one rule (*"may not use alternative methods … to derive data attributed
   to Call Log or SMS related permissions"*) plus one eligibility list that names
   "assistants" and "monitoring apps" as ineligible. Arguing any of them individually is
   wasted effort.

---

## 11. Sources

Google Play (Play Console Help / Policy Center), retrieved 2026-08-13:

- [Use of SMS or Call Log permission groups](https://support.google.com/googleplay/android-developer/answer/10208820)
- [Permissions and APIs that Access Sensitive Information](https://support.google.com/googleplay/android-developer/answer/16558241)
- [Preview: Permissions and APIs that Access Sensitive Information](https://support.google.com/googleplay/android-developer/answer/16909972)
- [Understanding Restricted Permissions with minimum scope alternatives](https://support.google.com/googleplay/android-developer/answer/16935362)
- [Details on Google Play's Photo and Video Permissions policy](https://support.google.com/googleplay/android-developer/answer/14115180)
- [Android Health Permissions: Guidance and FAQs](https://support.google.com/googleplay/android-developer/answer/12991134)
- [Provide information for the Health apps declaration form](https://support.google.com/googleplay/android-developer/answer/14738291)
- [Understanding location in the background permissions](https://support.google.com/googleplay/android-developer/answer/9799150)
- [Use of the AccessibilityService API](https://support.google.com/googleplay/android-developer/answer/10964491)
- [Use of the QUERY_ALL_PACKAGES permission](https://support.google.com/googleplay/android-developer/answer/10158779)
- [Use of the All files access permission](https://support.google.com/googleplay/android-developer/answer/9956427)
- [User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)
- [Best practices for prominent disclosure and consent](https://support.google.com/googleplay/android-developer/answer/11150561)
- [Declare permissions for your app](https://support.google.com/googleplay/android-developer/answer/9214102)
- [Understanding foreground service and full-screen intent requirements](https://support.google.com/googleplay/android-developer/answer/13392821)
- [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469)
- [Understand app privacy & security practices with Data safety](https://support.google.com/googleplay/answer/11416267)
- [Policy announcement: April 15, 2026](https://support.google.com/googleplay/android-developer/answer/16926792) · [Policy announcement: July 15, 2026](https://support.google.com/googleplay/android-developer/answer/17134731)

Android developer docs:

- [Grant partial access to photos and videos](https://developer.android.com/about/versions/14/changes/partial-photo-video-access) · [Photo picker](https://developer.android.com/training/data-storage/shared/photo-picker) · [Access media files from shared storage](https://developer.android.com/training/data-storage/shared/media)
- [Health Connect — read raw data](https://developer.android.com/health-and-fitness/health-connect/read-data) · [Publish your health app on Google Play](https://developer.android.com/health-and-fitness/health-connect/publish)
- [Access location in the background](https://developer.android.com/develop/sensors-and-location/location/background)

Apple, retrieved 2026-08-13:

- [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/) — 5.1.1(iii)(v)(viii), 5.1.2(i)(iv)(vi), 5.1.3(i)(ii), 5.1.5
- [App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/) — definition of "collect", data types, optional-disclosure exception, definition of "tracking"
- [Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files) · [NSPrivacyCollectedDataTypes](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes)
- [HealthKit — Protecting user privacy](https://developer.apple.com/documentation/healthkit/protecting-user-privacy) · [HealthKit entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.healthkit.access)
- [Screen Time Technology Frameworks](https://developer.apple.com/documentation/screentimeapidocumentation) · [Family Controls](https://developer.apple.com/documentation/familycontrols) · [Configuring Family Controls](https://developer.apple.com/documentation/xcode/configuring-family-controls)
- Purpose-string keys: [NSCalendarsFullAccessUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nscalendarsfullaccessusagedescription) · [NSContactsUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nscontactsusagedescription) · [NSMotionUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nsmotionusagedescription) · [NSHealthShareUsageDescription](https://developer.apple.com/documentation/bundleresources/information-property-list/nshealthshareusagedescription)

Self-hosted precedent (live Play Data Safety listings, read 2026-08-13):
[Home Assistant](https://play.google.com/store/apps/datasafety?id=io.homeassistant.companion.android) ·
[Immich](https://play.google.com/store/apps/datasafety?id=app.alextran.immich) ·
[Nextcloud](https://play.google.com/store/apps/datasafety?id=com.nextcloud.client) ·
[Bitwarden](https://play.google.com/store/apps/datasafety?id=com.x8bit.bitwarden)

---

_Research basis: primary-source pass 2026-08-13 against live Play Console Help, Play Policy
Center, Apple App Review Guidelines and Apple developer documentation. **Play shipped policy
updates on 2026-04-15 and 2026-07-15 with effective dates through 2027-01-27; Apple revises
the guidelines several times a year. Re-verify every claim in §2 before each submission.**_
