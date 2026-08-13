# Google Play — Health Apps Declaration: verification, verdict & response plan

> **Private & Confidential — Property of Lifescope Inc. Do not distribute.**
>
> Single-issue deep-dive on the Play **Health apps declaration**, opened because
> [`DEVICE_DATA_COMPLIANCE.md`](./DEVICE_DATA_COMPLIANCE.md) §6.1/§9 flagged it as a
> 🔴 P0 gap "already overdue" and told [`DELIVERY.md`](./DELIVERY.md) to add it to Phase 0.
> **That flag was materially right about the rule and wrong about the timing.** This file
> re-verifies the claim against primary sources, corrects the severity, and gives the
> exact response plan.
>
> Primary-source pass: **2026-08-13**, against live Play Console Help / Play Policy Center /
> Android developer docs. Every policy claim below is linked to the page it came from.
> **These pages move — re-verify before acting.**

Severity + owner tags follow `DELIVERY.md`:
🔴 **P0** blocks submission · 🟠 **P1** fix before launch · 🟢 **P2** polish ·
**[code]** in-repo · **[acct]** needs a Play Console seat · **[legal]** needs counsel.

---

## 0. Verdict

**Does it apply to us right now? No — not yet. There is no live violation and nothing is overdue.**

**When does it apply? The moment `com.companionintelligence.app` has a release active on a
Play *closed testing*, *open testing*, or *production* track.** The obligation binds
**published** apps; ours has never been uploaded to Play at all.

| Question | Answer |
|---|---|
| Is the rule real? | ✅ **Yes.** Verified verbatim in Play Console Help. |
| Does it bind developers with *zero* health features? | ✅ **Yes**, explicitly and in Google's own words. |
| Does it bind apps only in testing? | ✅ **Yes** — closed and open testing are named. **Internal testing is not named** (see §2.2 — important, and partly inferred). |
| Are we in violation today? | ❌ **No.** Nothing is published. See §4. |
| Is there a passed deadline we blew? | ❌ **No.** The 2024-08-31 date is a cutover for *then-published* apps, not a standing date we missed. |
| What does non-compliance actually cost? | Blocked updates — you cannot submit anything for review until the form is filed. Escalates from there. See §2.5. |
| Effort to comply | **~10 minutes**, one person, one form, no engineering. |
| Correct answer for us today | **"My app doesn't provide any health features."** — and per §3 that is **true**, not merely convenient. |
| Anything to fix first? | 🟠 **One thing.** Onboarding copy that ships in the APK promises *"Track workouts, monitor progress"* and *"align food choices with your health goals."* The certification survives it, but reword it first — **§3.3a**. |

> 🟠 **Reclassification.** `DEVICE_DATA_COMPLIANCE.md` §9 says *"Health apps declaration is
> already overdue."* **It is not overdue** — it cannot be, because nothing is published.
> It is a **gate on the first closed-testing upload**, which is a different instruction and a
> different anxiety level. Keep it in the `DELIVERY.md` Phase-0 list, but as a
> *pre-first-upload* item, not a remediation item.
>
> The distinction matters practically: "we are in violation" implies scrambling and possibly
> a support escalation. "Do this before the first upload" means it can be batched with the
> other Play Console first-run setup (Data safety, content rating, privacy policy URL, EU
> trader status) and costs nothing extra.

---

## 1. Why this was worth re-verifying

The claim arrived from a prior research pass with no citation trail, and it has the shape of
a thing that is *usually* wrong: a sweeping "every developer must" statement about a policy
whose name suggests it only concerns health apps. It turned out to be **correct on the
substance and overstated on the timing**. Both halves of that are worth recording, because
the pattern will recur across the other declarations in `DEVICE_DATA_COMPLIANCE.md`.

---

## 2. Verified facts

### 2.1 The rule, verbatim

From [Provide information for the Health apps declaration form](https://support.google.com/googleplay/android-developer/answer/14738291) (Play Console Help, read 2026-08-13):

> "All developers that have an app published on Google Play must complete the Health apps
> declaration, including apps on closed testing, open testing, or production tracks."

> "Even developers with apps that do not offer any health features must complete this form
> and certify that no health features are offered through the app."

> "This also applies to pregranted and preloaded apps that update through Google Play."

> "System services and private apps do not need to complete the Health apps declaration."

**So the original claim holds.** It is not a health-app-only obligation; it is a
universal-with-two-exceptions obligation, and the exceptions (system services, private apps)
do not cover us — Play "private apps" means managed-Google-Play enterprise distribution, not
"an app that happens to be for one user." Companion is a public-store consumer app.

### 2.2 Who exactly it binds — and the internal-testing question

The binding condition is **"have an app published on Google Play."** Three tracks are
enumerated: **closed testing, open testing, production**.

🟠 **Internal testing is conspicuously absent from that list, and I could not find a primary
source that says either way for the *health* declaration specifically.** Here is the honest
reasoning, kept separate from the verified facts:

- The **Data safety** form uses word-for-word the same construction —
  [*"All developers that have an app published on Google Play must complete the Data safety
  form, including apps on closed, open, or production testing tracks"*](https://support.google.com/googleplay/android-developer/answer/10787469)
  — and then states the carve-out explicitly: *"Apps that are active on internal testing
  tracks are exempt from inclusion in the data safety section. Apps that are exclusively
  active on this track do not need to complete the Data safety form."*
- The testing-tracks page corroborates that internal is deliberately lighter-touch:
  [*"You can start an internal test before you've finished setting up your app"*](https://support.google.com/googleplay/android-developer/answer/9845334),
  and *"Internal tests may not be subject to the usual Play policy or security reviews."*

**Inference (not a quoted rule): internal-testing-only apps are very likely outside the
health declaration too.** The phrasing is identical and the platform treats internal testing
as a pre-compliance track across the board.

> 🔴 **Do not lean on this.** The upside of relying on the inference is that you skip a
> 10-minute form. The downside is a blocked-updates state at exactly the moment you are
> trying to move from internal to closed testing. **File the declaration before the first
> upload to any track, including internal.** The asymmetry is absurd — there is no scenario
> where filing early costs anything.

### 2.3 What the form actually asks

The form is a category picker. From the same page, the seventeen health categories offered:

Activity and Fitness · Nutrition and Weight Management · Period Tracking · Sleep Management ·
Stress Management, Relaxation, Mental Acuity · Diseases and Conditions Management ·
Clinical Decision Support · Disease Prevention and Public Health · Emergency and First Aid ·
Healthcare Services and Management · Mental and Behavioral Health · Medical Reference and
Education · Medication and Treatment Management · Physical Therapy and Rehabilitation ·
Reproductive and Sexual Health · Medical Device Apps · Research studies, clinical trials, and
patient communities.

And the escape hatch, verbatim:

> "If your app doesn't provide any health features or access health data to support non-health
> features, you should declare: **My app doesn't provide any health features**"

Note the **two-limbed** test in that sentence. It is not just "do you have health features."
It is *"doesn't provide any health features **or access health data to support non-health
features**."* The second limb is the one that catches apps which slurp Health Connect data to
power a non-health feature. §3 checks both limbs against the actual codebase.

Selecting a category opens a second page asking for
[additional information](https://support.google.com/googleplay/android-developer/answer/13996367)
about the category and, for Health Connect apps, a per-data-type justification. **None of
that appears when you select "no health features"** — the no-health path is a single
checkbox and a submit.

After submission: *"The information that you provided will be reviewed by Google as part of
the app review process."* It is not a fire-and-forget attestation; it is checked against
observed app behaviour.

### 2.4 Deadlines

- **2024-08-31** — [*"After August 31, 2024, all apps will be required to have completed an
  accurate Health apps declaration that discloses the health features their app supports
  (including apps that do not support any health features)."*](https://support.google.com/googleplay/android-developer/answer/14738291)
  This was the end of a staggered rollout with per-developer deadlines during 2024. It is a
  **cutover date for apps that existed then**, not a date we are late for.
- **2025-01-22** — [deadline to migrate Health Connect data-type declarations out of the old
  Google Health Connect API Request form into Play Console](https://developer.android.com/health-and-fitness/health-connect/publish).
  Historical; irrelevant to us (we never filed the old form).
- **No open or rolling health-declaration deadline exists as of 2026-08-13.** I read the
  [Policy Deadlines table](https://support.google.com/googleplay/android-developer/table/12921780)
  end to end: the live 2026–2027 deadlines are Account Transfer (2026-05-27), anonymous-chat /
  child-safety and foreground-services changes (2026-08-26), Play Console Requirements
  (2026-09-30), and the Contacts / Location / SMS-Call-Log permission policies (2027-01-27).
  **None is health.**
- The [April 15, 2026 policy announcement](https://support.google.com/googleplay/android-developer/answer/16926792)
  did touch health — granular Android 16 permissions, new Health Connect types (Menstrual
  Cycle Phases, Alcohol Consumption, Symptoms), and a clarified ban on using sensitive health
  data for employment or insurance eligibility — but changed **nothing** about who must file
  the declaration. The [July 15, 2026 announcement](https://support.google.com/googleplay/android-developer/answer/17134731)
  contains no health changes at all.

🟢 **One 2026 health item to be aware of for later, not now:** the
[Health Content and Services policy](https://support.google.com/googleplay/android-developer/answer/16679511)
adds an EU **"Medical device"** label and MDR/IVDR identification requirements for apps
regulated as medical devices in the EEA/Northern Ireland (effective 2026-01-28). **Companion
is not and must not become a medical device** — see §5.4. Filed here so nobody rediscovers it
in a panic.

### 2.5 Enforcement — what actually happens

The stated, specific consequence for a **missing** declaration
([Android developer docs](https://developer.android.com/health-and-fitness/health-connect/publish)):

> "If you fail to complete the declaration form before the deadline, you will be unable to
> send any changes to your app registration for review until you have completed and submitted
> the declaration."

So: **not immediate removal. A publishing freeze.** You keep whatever is live and lose the
ability to ship anything new until you file. For a pre-launch app that means *the first
upload simply does not go through*, which is annoying rather than dangerous.

The consequence for an **inaccurate** declaration is worse and is a different animal.
"Health Content and Services policy: Inaccurate Health Apps Declaration" is a real, observed
Play rejection string (it appears repeatedly in the
[Play developer community](https://support.google.com/googleplay/android-developer/thread/283648630/health-content-and-services-policy-inaccurate-health-apps-declaration)).
From there, Play's [enforcement ladder](https://support.google.com/googleplay/android-developer/answer/9899234)
runs rejection → removal → suspension → account termination, and
*"Suspension can occur as the result of egregious or multiple policy violations, as well as
repeated app rejections or removals."*

> 🔴 **This is the whole reason §3 exists.** A late declaration costs you a blocked update.
> A **false** declaration costs you a rejection with a policy-violation label attached, on an
> account with no positive history to absorb it. **An incorrect declaration is strictly worse
> than a late one.** Do not check "no health features" because it is the fast box; check it
> because it is true.

### 2.6 Where in Console, and who can file it

**Navigation:** Play Console → select the app → **Policy** → **App content** → **Health apps**
→ **Start**.

🟢 The left-nav label has drifted across Console redesigns — Google's own pages variously say
*"Policy > App content"* ([14738291](https://support.google.com/googleplay/android-developer/answer/14738291))
and *"Policy and programs > App content"*
([pre-review checks](https://support.google.com/googleplay/android-developer/answer/14807773)).
**If the path doesn't match, search "App content" in the Console search bar.** The Health apps
card sits on that page alongside Privacy policy, Ads, Data safety, Sign-in details, Target
audience, Sensitive permissions and News apps declaration.

**Who can file it:** the governing Play Console permission is
[**"Manage policy declarations"**](https://support.google.com/googleplay/android-developer/answer/9844686)
— *"Edit and submit policy declarations, for example, the Data safety section and permission
declarations."*

- It is an **app-level** permission, not account-level.
- It can be held by the **account owner, an admin, or an ordinary user** — whoever the owner
  or an admin grants it to.

> **So the answer to "who at the company must act" is: not necessarily the account owner.**
> Anyone with *Manage policy declarations* on this app can file it. **But** the app must
> exist in Console first, and creating the app record — plus the developer-account, D-U-N-S /
> organization verification and Play App Signing enrolment in `DELIVERY.md` §1b — is
> owner-level work. **Practically, for a first-ever app the account owner is the critical
> path**, and delegating the form afterwards is the optimisation, not the plan.

---

## 3. Is "no health features" actually TRUE for us?

Because §2.5 makes an inaccurate declaration worse than a late one, "we have no health
features" has to be **verified, not assumed**. Recall the two-limbed test from §2.3: no health
features **and** no *"access [to] health data to support non-health features."*

> 🟠 **Dated snapshot — the permission surface is moving under this section.** As of
> 2026-08-13 there is uncommitted work in this tree adding **foreground location**
> (`ACCESS_COARSE_LOCATION` + `ACCESS_FINE_LOCATION`, `NSLocationWhenInUseUsageDescription`) —
> `DEVICE_DATA_COMPLIANCE.md`'s Phase 2. **This does not change the health answer:** location
> is not health data, maps to no category in §2.3, and the change adds no
> `ACTIVITY_RECOGNITION`, no `android.permission.health.*` and no motion API. It *does* add a
> Play **location** Permissions Declaration and a `Location → Precise location` row on the
> Data safety form, both of which are `DEVICE_DATA_COMPLIANCE.md` §3.4's problem, not this
> document's.
>
> **The general point stands: re-run this section against whatever is actually in the release
> candidate.** The permission to watch is `ACTIVITY_RECOGNITION`, queued for Phase 2 in
> `DEVICE_DATA_COMPLIANCE.md` §2 row 6. It needs no *restricted-permission* form — but that
> same row maps it to Data Safety **`Health and fitness → Fitness info`**. **Declaring
> "Fitness info" collected while certifying "no health features" is a contradiction on a
> single Console page**, and §2.5 shows what Play does with those. My read is that motion
> ingestion should flip the declaration to **Activity and Fitness**; that is a judgement call,
> not a quoted rule, so **settle it before Phase 2 ships rather than at review time** (§6.4
> is the escalation route).

### 3.1 Limb one — no health data capability. ✅ Verified mechanically.

**Android permission surface — the *merged* manifest, which is what actually ships** (the
hand-written `AndroidManifest.xml` lists only 6 of these; the rest arrive from plugin
manifests via the merger):

`INTERNET` · `ACCESS_NETWORK_STATE` · `CAMERA` · `RECORD_AUDIO` · `MODIFY_AUDIO_SETTINGS` ·
`POST_NOTIFICATIONS` · `RECEIVE_BOOT_COMPLETED` · `WAKE_LOCK` · `FOREGROUND_SERVICE` ·
`FOREGROUND_SERVICE_DATA_SYNC`

**Ten permissions, that is the complete list.** The last four come from
`@capacitor/local-notifications` and `@ci/capacitor-local-llm`. Plus a non-required
`<uses-feature android:name="android.hardware.camera">` and two `<queries>` entries
(`TTS_SERVICE`, `CustomTabsService`).

> ⚠️ **Read the merged manifest, not the source one, when you fill in any Play declaration.**
> `frontend/apps/mobile/android/app/src/main/AndroidManifest.xml:45-51` shows 6 permissions;
> the build merges in 4 more. Declaring from the source file under-reports by 40%. The merged
> output lands at
> `frontend/apps/mobile/android/app/build/intermediates/merged_manifest/…/AndroidManifest.xml`.

**Absent and confirmed absent:** `android.permission.health.*`, `BODY_SENSORS`,
`BODY_SENSORS_BACKGROUND`, `ACTIVITY_RECOGNITION`, `FOREGROUND_SERVICE_HEALTH`, any
`androidx.health.*` Gradle dependency, any Health Connect client, and any `<queries>` entry
for `com.google.android.apps.healthdata`. Gradle deps are appcompat, coordinatorlayout,
core-splashscreen and the eight Capacitor plugin projects — nothing else.

🟢 Note `FOREGROUND_SERVICE_DATA_SYNC` (not `…_HEALTH`) is the declared FGS type. If Phase 3
ever syncs health in a foreground service, `DEVICE_DATA_COMPLIANCE.md` §3.1's note about an
FGS `health` type declaration applies and this changes.

**iOS purpose-string surface**, complete, from `frontend/apps/mobile/ios/App/App/Info.plist`:

`NSCameraUsageDescription` (`:40`) · `NSMicrophoneUsageDescription` (`:42`) ·
`NSSpeechRecognitionUsageDescription` (`:53`) · `NSPhotoLibraryAddUsageDescription` (`:55`)

No `com.apple.developer.healthkit` entitlement (there is no `App.entitlements` file at all —
`DELIVERY.md` §3 confirms the first one would arrive with push), no
`NSHealthShareUsageDescription`, no `NSHealthUpdateUsageDescription`, no
`NSMotionUsageDescription`, no CoreMotion.

**Capacitor plugin surface**, complete, from `frontend/apps/mobile/package.json:18-31`:
`@capacitor/{android,app,browser,core,ios,local-notifications,splash-screen,status-bar}`,
`@ci/capacitor-{local-hub,local-llm,speech}`, `capacitor-secure-storage-plugin`. The lockfile
resolves ~80 packages, **zero** matching health / fitness / motion / pedometer / Health
Connect. None of the three first-party plugins references `SensorManager`, `CMPedometer`,
`CMMotionActivityManager`, `HKHealthStore` or Health Connect in any `.kt`/`.swift`/`.ts`.

Repo-wide, `heartRate|bloodPressure|stepCount|sleepData|bodyWeight|biometric|hrv|spo2|glucose`
returns **zero hits** across all frontend and backend TypeScript.

### 3.2 Limb two — no health data powering non-health features. ✅ Verified.

The second limb catches an app reading Health Connect to feed something unrelated. **We cannot
be reading Health Connect: the permission that gates it is not in the manifest, and no Health
Connect client library is linked.** There is no code path to health data on either platform.
Limb two fails to trigger for a mechanical reason, which is the strongest kind of "no."

### 3.3 What a cautious reviewer could actually argue

Five things surfaced. Four are noise. **One is a genuine, fixable exposure and you should deal
with it before filing.**

#### 🟠 [code] 3.3a — Onboarding "focus areas" copy promises fitness and nutrition tracking. **This ships in the APK.**

`frontend/apps/web/src/pages/OnboardingPage/FocusAreas.tsx:5-16`, verbatim:

```
id: 'personal_fitness', label: 'Personal fitness and health',
description: 'Track workouts, monitor progress, and build habits that support long-term physical wellbeing'

id: 'nutrition',        label: 'Nutrition and meal planning',
description: 'Plan meals, organize grocery lists, and align food choices with your health goals'
```

Reachable at `/onboarding` (`frontend/apps/web/src/App.tsx:151`) and **verified present in the
web bundle checked in under
`frontend/apps/mobile/android/app/src/main/assets/public/assets/`** — i.e. it is in the
binary, not just the source tree.

**What it actually is:** a checkbox of interest topics, stored as a preference answer that
steers LLM context. No measurement, no tracking, no health data field is created, nothing is
read from a sensor. **On the substance, this is not a health feature and the certification
survives it.**

**Why it is still the thing most likely to be challenged:** the *copy* says "Track workouts,
monitor progress" and "align food choices with your health goals." Those two strings map
almost word-for-word onto two of the seventeen categories in §2.3 — **Activity and Fitness**
and **Nutrition and Weight Management**. A reviewer who sees them in a screenshot, or a Play
scanner that reads shipped strings, has a ready-made argument that the app advertises health
features while declaring none. That is the exact shape of the "Inaccurate Health Apps
Declaration" rejection in §2.5.

> **Recommendation (🟠 [code], not this document's author to make):** before the first Play
> upload, reword those two `description` strings to drop "Track workouts, monitor progress"
> and "health goals" — e.g. frame them as *topics Companion should pay attention to* rather
> than as capabilities Companion provides. **The certification is defensible either way; this
> just removes a free argument from the other side.** Do not delete the focus areas — the
> feature is fine, only the promissory verbs are a liability.

#### 🟢 3.3b — Onboarding asks for bedtime and wake time

`frontend/apps/web/src/pages/OnboardingPage/TimeAndPlaceStep.tsx:32-53` ("Usually wake up" /
"Usually go to bed", defaults 07:00/21:00), persisted as free-text preference answers under
subcategory `Schedule` (`backend/apps/api/src/domains/onboarding/services/OnboardingService.ts:452-480`).

**Self-declared scheduling preference, not measured sleep.** No duration, quality, stage or
trend data — nothing Play's **Sleep Management** category describes. A calendar app asking
your working hours is the same thing. **Low risk; no action.**

#### 🟢 3.3c — `SLEEP` and `EXERCISE` are two of HBPE's eight activity classes, and they render in the mobile UI

HBPE is a per-user *scheduling* forecaster, not a health engine. It reads calendar/task rows,
content and communications, asks a local Qwen model to classify each item's **title string**
into one of eight fixed classes — `WORK, EXERCISE, SOCIAL, ERRAND, LEISURE, TRANSIT, SLEEP,
UNKNOWN` — and turns that into a 48-bucket day-ahead probability histogram. The chips surface
on `/schedule` and `/plan` via `ForecastStrip`, `HorizonGrid`, `WeekAhead`; the colour map and
keyword rules live in `frontend/apps/web/src/lib/activityPalette.ts:24-33, 60-68, 156, 163`.

**These are keyword classifications of the user's own calendar text** — if your calendar says
"Yoga 6pm" the chip colours as EXERCISE. **No biometric, sensor, wearable, mood, stress or
nutrition input exists**; HBPE never read one. This is scheduling analytics, not health
analytics, and no §2.3 category covers "your calendar has a gym entry."

`DEVICE_DATA_COMPLIANCE.md` §3.1 correctly flags HBPE as where health data would get
*interesting* — but that is a **Phase-3, post-ingestion** concern. With no health input there
is nothing health-shaped to predict from. **Re-examine at Phase 3, not now.**

#### 🟢 3.3d — Migration comments naming `heart_rate`, `steps`, `mood_score`, `stress_level`

Historical SQL comments in `backend/apps/api/db/postgres/migrations/2025092515*.sql` describe
`ci.measurements` (`'heart_rate'`, `'steps'`), `ci.activities` (`energy_level`, `mood_score`,
`stress_level`), `ci.habit_completions` (`mood_before`, `mood_after`), and `heart_rate_sensor`
as an example `source_system`.

**Every one of those tables was dropped and never recreated** —
`20260212191500_drop_unused_tables_and_document_chunk_function.sql:5-14` and
`20260213131500_drop_screen_captures_and_sensors.sql:5`. Only the comment text survives in
migration history. **No live table, no column, no code path, and nothing in the mobile app.**
Backend-only and dead. **No action** — but expect this to be the first thing a repo-wide grep
turns up, which is why it is recorded here.

#### 🟢 3.3e — The `/api/health` false positive

Grepping for "health" hits `frontend/packages/capacitor-local-hub/**` and
`frontend/packages/common/src/utils/{connectionMode,localHub}.ts` a couple of dozen times.
**Every one is the Local Hub's *liveness* endpoint** (`GET /api/health`, a
bearer-authenticated up/down probe used by the connection-mode resolver). Server-health, not
user-health.

#### 🔴 [acct] 3.3f — The self-inflicted wound: do not copy `DEVICE_DATA_COMPLIANCE.md`'s tables into Console today

`DEVICE_DATA_COMPLIANCE.md` §6.1 lines 411-412 pre-fill a Data Safety table with
`Health and fitness → Fitness info ✅ (P2, motion)` and `Health and fitness → Health info ✅ (P3)`,
and §6.2 line 437 has `Health & Fitness → Health, Fitness ✅ Linked` on the Apple label.

**Those are Phase-2/Phase-3 *plans*, not today's answers.** The phase tags say so, but they
are easy to miss in a table that otherwise reads like a fill-in-the-form crib sheet. **If
anyone transcribes those rows into the Console while filing the Data Safety form, they
directly contradict the health certification filed on the same page, in the same session.**
That is a manufactured inconsistency and exactly what §2.5 punishes.

> **Rule: on the first submission, declare only what Phase 0/1 actually does. Every row in
> `DEVICE_DATA_COMPLIANCE.md` §6.1/§6.2 tagged P2, P3 or P4 is a future answer, not a current
> one.**

### 3.4 Verdict on truthfulness

> ✅ **"My app doesn't provide any health features" is TRUE for `com.companionintelligence.app`
> as it stands today**, on both limbs of the test. **Confidence: high (~95%).**
>
> The core of the verification is mechanical — absent permissions, absent entitlements, absent
> libraries, absent columns — rather than interpretive, which is what makes it safe to certify.
> The app has no capability to obtain health data, so it cannot have a health feature no matter
> how the copy reads.
>
> 🟠 **Do 3.3a first anyway.** Rewording two onboarding strings is ten minutes of work that
> removes the only argument anyone could mount against the certification. Being right is not
> the same as being un-arguable, and this account has no review history to spend.
>
> 🟠 **Residual 5%, honestly:** the audit read the *checked-in* web bundle and the merged
> *debug* manifest, not a decompiled signed AAB — a fresh `yarn build:web && cap sync` before
> release could in principle pull in new code, so **re-run the health-surface check against
> the release candidate**. And the "no iOS entitlements file" finding is solid for the repo
> but an Xcode capability toggle could add one without it being committed; the iOS project has
> reportedly never been compiled, so **get a one-line confirmation from whoever first builds
> on a Mac.**
>
> 🟠 **This verdict has a shelf life.** It describes the binary above and stops being true the
> moment Phase 3 lands. §6 owns that transition.

---

## 4. Current store status — why nothing is overdue

Verified in-repo, 2026-08-13:

- [`DELIVERY.md`](./DELIVERY.md) §1b lists **every** Android store prerequisite as unchecked
  🔴 **[acct]**: release signing, upload keystore, Play App Signing enrolment. §1c lists the
  privacy policy URL, Data Safety form and EU trader status as unchecked.
- [`DELIVERY.md`](./DELIVERY.md) §1a: *"`mobile-build.yml` only produces an unsigned debug
  APK + a Simulator `.app`"* — confirmed at
  `.github/workflows/mobile-build.yml:8` (*"Android — a debug APK (sideload-installable; not
  for store distribution)"*) and `:10` (*"Signed, device-/store-ready artifacts (release
  APK/AAB, signed .ipa) require the…"* signing secrets, which are not wired).
- No `bundleRelease` lane, no `fastlane`/`supply` config, no Play publishing service account
  anywhere in the repo.
- [`DELIVERY.md`](./DELIVERY.md) §2 describes shipping *to* Play closed/internal testing as a
  **future** step.

**Conclusion: `com.companionintelligence.app` has never been uploaded to any Play track, and
there is very likely no Play Console app record yet.** The declaration obligation has not
attached. There is no violation, no missed deadline, and no exposure today.

> 🟢 **[acct] Worth confirming in Console anyway.** This is an inference from the repo, and
> the repo cannot see the Console. If a Lifescope Play developer account already exists with a
> `com.companionintelligence.app` draft or an internal-testing upload someone made by hand,
> the picture changes. **Two minutes: log in, check whether the app record exists and whether
> any track has an active release.** Do this before trusting §0.

---

## 5. The response plan

### 5.1 🔴 [acct] Trigger point — the one rule to remember

> **File the Health apps declaration before the first upload to *any* Play track.**

Not "before production." Not "when Google emails us." Before the first upload, full stop.
It is a checkbox, it costs ten minutes, and doing it early removes the internal-testing
ambiguity in §2.2 entirely.

### 5.2 🔴 [acct] Exact steps

| # | Step | Owner | Detail |
|---|---|---|---|
| 0 | 🟠 Reword the two onboarding `description` strings | **[code]** | §3.3a. Optional for correctness, recommended for a quiet review. Not a blocker — if it slips, file anyway. |
| 1 | Confirm/create the Play Console app record | **[acct]** owner | Blocked on the developer account + organization verification in `DELIVERY.md` §1b. |
| 2 | Navigate | **[acct]** | **Policy → App content → Health apps → Start** (§2.6; search "App content" if the nav differs). |
| 3 | Answer | **[acct]** | Select **"My app doesn't provide any health features."** Do **not** tick any of the seventeen categories in §2.3 — in particular not *Activity and Fitness*, not *Nutrition and Weight Management*, and not *Stress Management, Relaxation, Mental Acuity*, which are the three a careless reading of this product could reach for. |
| 4 | Submit | **[acct]** | No second page, no justification prompts, no video. |
| 5 | Do **not** contradict it on the same page | **[acct]** | While you are on App content you will also meet the Data safety form. **Answer it for Phase 0/1 only.** Every `Health and fitness` row in `DEVICE_DATA_COMPLIANCE.md` §6.1/§6.2 is tagged P2/P3 and is a *future* answer — see §3.3f. |
| 6 | Record it | **[acct]** | Note the submission date here and tick the box in `DELIVERY.md` §1c. |

**Owner:** anyone holding *Manage policy declarations* on the app; in practice the Play
account owner, because they are the one standing up the app record.
**Elapsed time:** ~10 minutes once the app record exists.
**Dependencies:** Play Console app record only. It does **not** depend on the demo server,
the purge job, signing, or anything else in `DELIVERY.md`'s 🔴 list — **so it can be done the
day the account exists, well ahead of everything else.** Do it first; it is the cheapest item
on the entire P0 list.

### 5.3 🟢 [acct] Re-check before every submission

The declaration must stay accurate over time, and the analogous Data safety guidance is
explicit about the standing duty:
[*"Your Data safety form responses must remain accurate and complete at all times."*](https://support.google.com/googleplay/android-developer/answer/10787469)
Treat the health declaration the same way. **Add "re-read the Health apps declaration" to the
pre-submission ritual for every release that touches device data.**

### 5.4 🟢 [legal] Do not become a medical device

Recorded so it is never accidental: the moment the product makes a diagnostic, therapeutic or
clinical-decision claim about the user's health, it is potentially in scope for the EU MDR /
IVDR regime and the Play **"Medical device"** label
([Health Content and Services](https://support.google.com/googleplay/android-developer/answer/16679511),
effective 2026-01-28), which requires *"proof of approval, clearance or certification by the
relevant authority."* **Product rule: Companion describes and correlates; it does not
diagnose, treat, or advise.** Non-medical-device health apps also have to carry the
disclaimer that the app *"is not a medical device and does not diagnose, treat, cure, or
prevent any medical condition."* Fold that string into the health feature's UI when it ships.

---

## 6. The forward path — when health ingestion lands

`DEVICE_DATA_COMPLIANCE.md` §3.1 and §7 put Health Connect / HealthKit in **Phase 3**. That
means the declaration filed under §5.2 **will** have to flip from "no health features" to a
category. This section answers whether that flip is routine.

### 6.1 Re-declaring is the documented, expected process — not an exception

From [Publish your health app on Google Play](https://developer.android.com/health-and-fitness/health-connect/publish),
which addresses updating an existing declaration directly. When data-type requirements change
you fill out the form **again**, and the submission must:

- include **all existing** health features the app still uses,
- include **all new** health features the app requires,
- **exclude** all health features the app no longer needs,
- **justify every requested access**.

It also notes *"The data type accesses are allow-listed for a package name regardless of app
version"* and that you *"don't have to file a new request just to change the app version."*

**So: re-declaring is a first-class, documented flow.** Google explicitly contemplates apps
whose health surface changes. There is **no primary-source evidence** that a prior "no health
features" answer creates a penalty, a flag, or elevated scrutiny when it flips.

### 6.2 What the real risk is — and it isn't the flip

The risk is not the *transition*. It is **being wrong at any single point in time.** The
"Inaccurate Health Apps Declaration" rejection (§2.5) fires when the app's observed behaviour
disagrees with the standing declaration. That produces one hard sequencing rule:

> 🔴 **[acct] The updated declaration must be filed and submitted with — or before — the
> build that contains the health code. Never after.**
>
> A build that reads Health Connect while the declaration on file says "no health features"
> is not a paperwork lag; it is precisely the mismatch Google rejects for. In practice:
> update the declaration **in the same Console session** in which you upload the Phase-3
> build, before you roll out the release. There is no grace window and none is documented.

This is also why `DEVICE_DATA_COMPLIANCE.md` §7's advice to ship health **in a release
containing nothing else you care about** is the right call — the declaration change and the
binary change have to move together, so put nothing else at risk in that release.

### 6.3 How to word the first declaration given known future intent

**Answer: word it for today's truth, and nothing else.**

The "no health features" checkbox is not free-text — there is no wording to optimise, no
place to signal future intent, and no way to pre-register a plan. Selecting a Phase-3
category *now* to "get ahead of it" would be an **inaccurate declaration today**, which is
the one failure mode §2.5 says to avoid, and would additionally drag `Fitness and wellness`
justification questions and Health Connect data-type prompts into a review where the app has
no health code to demonstrate. That is a self-inflicted rejection.

The one genuine forward-looking action available is in `DEVICE_DATA_COMPLIANCE.md` §3.1: when
Phase 3 arrives, declare **Activity and Fitness** framed on Google's own journaling language,
not as a "personal memory vault." That is a Phase-3 decision, and it is already recorded
there. Nothing about it needs to be pre-empted now.

### 6.4 🟠 [legal] Ask a human, don't guess

Two questions cannot be answered from public documentation and **should not be guessed at**:

1. **Does Play track declaration-change history as a trust/risk signal on the account?**
   Nothing public says it does, and nothing public says it doesn't. Play's internal risk
   scoring is not documented.
2. **Does a "no health features" → "Activity and Fitness" flip trigger a heavier manual
   review than a first-time health declaration would have?** Unknown. The community evidence
   in §2.5 is about *mismatches*, not about *transitions*, and I found no case describing a
   clean transition.

**Route:** raise both with Play developer support ahead of Phase 3, or with counsel if the
answer would change the release plan. **Do not let a plausible-sounding guess about either
become a load-bearing assumption in the Phase-3 schedule.**

---

## 7. What we could not determine from public sources

Stated plainly, with no papering over:

1. 🟠 **Whether internal-testing-only apps are exempt from the *health* declaration.** Google
   states the exemption for Data safety and does not state it for health, while using
   identical scope language for both. §2.2 is an **inference**. Mitigation: file before the
   first upload to any track, which makes the question moot.
2. 🟠 **Whether "published" includes an app record that exists but has never had a release
   rolled out** (a pure draft). Not addressed anywhere. Almost certainly not — "published"
   plainly means a live release — but not verified. Same mitigation.
3. 🟠 **The exact on-screen text and layout of the Console form.** Everything in §2.3 is from
   Help-page prose, not from the live form. Google's own help pages disagree on the left-nav
   path (§2.6), which suggests the UI has moved since the docs were written. **Whoever files
   it should correct §2.3/§2.6 against what they actually see.**
4. 🟠 **Whether a declaration change is a risk signal, and whether the "no" → "yes" flip draws
   extra scrutiny.** See §6.4. Genuinely undocumented; escalate rather than assume.
5. 🟠 **Whether Play would treat a self-hosted appliance that merely *stores* user-supplied
   health-ish text as a "health feature."** Our §3 conclusion rests on the app having no
   health *ingestion* and no health *presentation*. A user typing "slept badly, 5 hours" into
   a free-text note is user content, not a health feature — that is the correct and
   conventional reading (every notes app on Play would otherwise be a health app), but it is a
   reading, not a quoted rule.
6. 🟢 **Whether a missing declaration blocks a *first* upload or only *updates*.** Google's
   wording is *"unable to send any changes to your app registration for review"*, which reads
   as covering both. Untested for a never-published app, and not worth testing.

**And two limits on the repo-side verification**, which are gaps in *our* evidence rather than
in Google's docs — restated from §3.4 so they are not lost:

7. 🟠 The health-surface audit read the **checked-in** web bundle and the **merged debug**
   manifest, not a decompiled signed AAB. **Re-run it against the release candidate.**
8. 🟠 The "no iOS entitlements file" finding is solid for the repo, but an Xcode capability
   toggle can create one without it being committed, and the iOS project has reportedly never
   been compiled. **Confirm with whoever first builds on a Mac.**

---

## 8. Sources

All Play Console Help / Play Policy Center / Android developer pages read **2026-08-13**:

- [Provide information for the Health apps declaration form](https://support.google.com/googleplay/android-developer/answer/14738291) — **the controlling page**: who must file, testing-track scope, the "no health features" option, the 17 categories, the 2024-08-31 date, Console path.
- [Health app categories and additional information](https://support.google.com/googleplay/android-developer/answer/13996367) — category detail and the second-page questions.
- [Health Content and Services (policy)](https://support.google.com/googleplay/android-developer/answer/16679511) — the policy the declaration enforces; medical-device labelling, disclaimer, privacy-policy requirements.
- [Publish your health app on Google Play](https://developer.android.com/health-and-fitness/health-connect/publish) — enforcement wording ("unable to send any changes… for review"), the re-declaration process, package-name allow-listing, the 2025-01-22 migration date.
- [Android Health Permissions: Guidance and FAQs](https://support.google.com/googleplay/android-developer/answer/12991134) — approved use cases (Phase-3 relevant; does **not** cover the declaration process itself).
- [Provide information for Google Play's Data safety section](https://support.google.com/googleplay/android-developer/answer/10787469) — the parallel-construction scope language and the explicit internal-testing exemption relied on in §2.2; the standing-accuracy duty.
- [Set up an open, closed, or internal test](https://support.google.com/googleplay/android-developer/answer/9845334) — internal-testing latitude ("start before you've finished setting up your app"; "may not be subject to the usual Play policy or security reviews").
- [Add developer account users and manage permissions](https://support.google.com/googleplay/android-developer/answer/9844686) — the *Manage policy declarations* permission, app-level scope, which access levels can hold it.
- [Detect app issues early with pre-review checks](https://support.google.com/googleplay/android-developer/answer/14807773) — App content declarations as blocking pre-review checks; the alternate nav label.
- [Policy Deadlines](https://support.google.com/googleplay/android-developer/table/12921780) — read end-to-end; **no live health deadline**.
- [Policy announcement: April 15, 2026](https://support.google.com/googleplay/android-developer/answer/16926792) · [Policy announcement: July 15, 2026](https://support.google.com/googleplay/android-developer/answer/17134731) — the two most recent policy updates; neither changes the declaration obligation.
- [Enforcement Process](https://support.google.com/googleplay/android-developer/answer/9899234) — rejection → removal → suspension → termination.
- [Play developer community: "Health Content and Services policy: Inaccurate Health Apps Declaration"](https://support.google.com/googleplay/android-developer/thread/283648630/health-content-and-services-policy-inaccurate-health-apps-declaration) — evidence the rejection string exists in the wild. **Secondary source; treated as corroboration only.**

In-repo, read 2026-08-13 — store status: [`DELIVERY.md`](./DELIVERY.md) §1a/§1b/§1c/§2 ·
[`DEVICE_DATA_COMPLIANCE.md`](./DEVICE_DATA_COMPLIANCE.md) §3.1/§6.1/§6.2/§7/§9 ·
`.github/workflows/mobile-build.yml:8,10`.

Health-surface audit (§3): `frontend/apps/mobile/android/app/src/main/AndroidManifest.xml` +
the generated merged manifest under `android/app/build/intermediates/merged_manifest/` ·
`frontend/apps/mobile/ios/App/App/Info.plist` (+ absence of any `*.entitlements`) ·
`frontend/apps/mobile/package.json`, `yarn.lock` ·
`frontend/packages/capacitor-{local-hub,local-llm,speech}/**` ·
`frontend/apps/web/src/pages/OnboardingPage/{FocusAreas,TimeAndPlaceStep}.tsx` ·
`frontend/apps/web/src/lib/activityPalette.ts` · `frontend/apps/web/src/App.tsx` ·
`backend/apps/api/src/domains/onboarding/services/OnboardingService.ts` ·
`backend/apps/hbpe/src/ci/hbpe/**` · `backend/apps/api/db/postgres/migrations/**`.

---

_Verification basis: primary-source pass 2026-08-13 against live Play Console Help, Play
Policy Center and Android developer documentation, plus a repo-wide health-surface audit.
**Play policy pages change without notice and Google's own help pages already disagree on the
Console navigation path. Re-verify §2 before filing, and correct this document from what you
actually see in Console.**_
