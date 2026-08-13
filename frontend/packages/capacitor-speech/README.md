# @ci/capacitor-speech

Capacitor plugin for **offline speech**: on-device recognition (STT) and synthesis (TTS)
for the CI-Server mobile app. Like `@ci/capacitor-local-hub` (and unlike Android-only
`@ci/capacitor-local-llm`), it ships native implementations for both Android and iOS.

## The one rule this API is built around

> Never let a caller believe audio stayed on the device when that cannot be proven.

"Offline speech recognition" is not a single guarantee. What the OS will actually promise
changes twice between this project's `minSdk` (23) and its `targetSdk` (35), and on iOS it
varies by device *and* locale rather than by OS version. A privacy-positioned product
cannot paper over that, so every capability answer, every `startListening()` result, and
**every result event** carries a `guaranteedOnDevice` boolean plus a `mode`:

| `mode`         | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `on-device`    | The platform guarantees the audio is processed locally.                      |
| `best-effort`  | We asked for offline and **cannot verify** we got it.                        |
| `network`      | A recognizer that may send audio off-device (only under the `allow` policy). |
| `unavailable`  | No usable recognizer.                                                        |

The default `onDevicePolicy` is `require`, so doing nothing gets you the private behavior
and an explicit rejection when the device cannot deliver it. `prefer` and `allow` are opt-in
and must be typed out by the caller.

## Android: three tiers

| API level | Path                                                                                          | `guaranteedOnDevice` | Language pack visibility                                    |
| --------- | --------------------------------------------------------------------------------------------- | -------------------- | ----------------------------------------------------------- |
| 33+       | `checkRecognitionSupport()` pre-flight → `createOnDeviceSpeechRecognizer()`; `triggerModelDownload()` can fetch a missing pack | **yes**              | `installed` / `downloadable` / `downloading` / `unsupported` |
| 31–32     | `isOnDeviceRecognitionAvailable()` → `createOnDeviceSpeechRecognizer()`                        | **yes**              | `unknown` — a missing model only appears at runtime as `ERROR_LANGUAGE_UNAVAILABLE` |
| 23–30     | `createSpeechRecognizer()` + `RecognizerIntent.EXTRA_PREFER_OFFLINE`                           | **no**               | `unknown`                                                    |

Two things worth stating plainly, because both are easy to get wrong:

- **`EXTRA_PREFER_OFFLINE` is a hint.** AOSP's own documentation says these values "may have
  no effect" depending on the recognizer implementation, and no callback reports whether the
  request was honored. That is precisely why the 23–30 tier reports `best-effort`, never a
  guarantee, and why the `require` policy refuses to start there.
- **`isOnDeviceRecognitionAvailable()` is only a framework-resource lookup.** It answers "is
  there an on-device recognition *service*", not "is a language model downloaded".
  Availability is not usability, so the plugin tracks the language pack as a separate axis
  from availability.

`SpeechRecognizer` is also `@MainThread` throughout and must be `destroy()`ed — a leaked
recognizer wedges later sessions with `ERROR_RECOGNIZER_BUSY`. `SpeechRecognitionController`
confines all its state to the main thread and always tears down.

### TTS on Android

`android.speech.tts.TextToSpeech`, with three specific hazards handled:

- **`<queries>` is mandatory.** An app targeting Android 11+ cannot bind to a TTS engine —
  each engine is a separate package — unless it declares the `TTS_SERVICE` intent in a
  `<queries>` element. Without it `onInit` reports `ERROR` and nothing works. Declared in this
  package's `android/src/main/AndroidManifest.xml` and mirrored in the host app's manifest.
- **Init is asynchronous.** `speak()` calls issued before `OnInitListener` fires are dropped
  by the framework, so they are queued here and replayed (or failed) when the engine answers.
- **`getMaxSpeechInputLength()` is a hard cap.** An LLM answer routinely exceeds it and the
  engine simply refuses the call, so long text is chunked on sentence/word boundaries and the
  promise settles on the *last* chunk's `onDone` via `setOnUtteranceProgressListener`.

Voices are reported with the platform's own `isNetworkConnectionRequired()` answer, and
`speak({ requireOfflineVoice: true })` (the default) refuses a voice that declares it needs a
network. `LANG_MISSING_DATA` is surfaced as `languageStatus: 'missing-data'`, and
`installSynthesisLanguage()` fires `ACTION_INSTALL_TTS_DATA` so the user can fix it.

## iOS

`SFSpeechRecognizer` + `SFSpeechAudioBufferRecognitionRequest` with
`requiresOnDeviceRecognition`, gated on a **runtime** check of `supportsOnDeviceRecognition`
(Apple: a request only honors the flag when that property is true, and it varies by device
and locale). There is no `best-effort` rung on iOS — it either recognizes locally or sends
audio to Apple — so `prefer` behaves exactly like `require` there rather than quietly
degrading.

- **Two authorizations.** `SFSpeechRecognizer.requestAuthorization` is separate from and
  additional to the `AVAudioSession` record permission; `requestPermissions()` asks for both.
- **`NSSpeechRecognitionUsageDescription` is required.** Apple states the app *crashes* when
  requesting speech authorization without it. Added to
  `frontend/apps/mobile/ios/App/App/Info.plist` (`NSMicrophoneUsageDescription` was already
  there).
- **~1 minute cap per task.** The session is stopped deliberately at 55s with
  `speechEnd { reason: 'max-duration' }` and a `max-duration` error event, and
  `maxDurationMs` is reported up front, so a long dictation cannot silently truncate.
- **The synthesizer is a stored property.** Apple documents that the system does not retain
  `AVSpeechSynthesizer`; a local one deallocates mid-sentence and the speech cuts out.
- **`usesApplicationAudioSession = false`.** This app also records audio; leaving the default
  (`true`) lets TTS reconfigure the same `AVAudioSession` the microphone is using, which is
  exactly what breaks a talk-then-listen loop.

Apple publishes no per-voice "requires network" flag, so `SpeechVoice.offline` is always
`false` on iOS and means **unknown**, not "requires network". No unqualified "works offline"
claim is made for non-default voices anywhere in this package.

## Web

There is no web implementation, by design. `src/web.ts` reports `unavailable`.

Chrome's Web Speech API exists but streams captured audio to Google's servers, and exposes no
way to verify a session ran locally. Silently routing a privacy-first memory app's microphone
through a cloud recognizer as a "graceful fallback" is the exact failure mode this plugin's
API is shaped to prevent. `speechSynthesis` is a weaker case (it sends text, not microphone
audio) but still offers no reliable "this voice is local" signal, so it is left out too
rather than shipping an `offline: true` we cannot stand behind.

## Contract

See `src/definitions.ts` — it is the source of truth for native parity on both platforms.
Summary:

```ts
checkPermissions() / requestPermissions({ permissions? })
getRecognitionCapability({ language? })   // available, mode, guaranteedOnDevice, languagePack, tier
getRecognitionLanguages()                 // { languages, enumerable }   — enumerable only on Android 33+
downloadRecognitionLanguage({ language }) // Android 33+ triggerModelDownload
startListening({ language?, partialResults?, onDevicePolicy?, maxAlternatives?, silenceTimeoutMs? })
stopListening() / cancelListening() / isListening()

getSynthesisCapability({ language? })
getVoices({ language? }) / getSynthesisLanguages() / installSynthesisLanguage()
speak({ text, language?, voiceId?, rate?, pitch?, interrupt?, requireOfflineVoice? })  // resolves on completion
stopSpeaking() / isSpeaking()

addListener('speechPartialResult' | 'speechResult' | 'speechError' | 'speechEnd', fn)
```

`startListening()` resolves as soon as the recognizer is listening; transcripts arrive as
events, so subscribe first. `speak()` resolves when the utterance *finishes*, not when it
starts, so a talk-then-listen loop can await it before opening the microphone.

`@ci/common/src/utils/speech.ts` wraps all of this for the web app (lazy
`window.Capacitor.Plugins.Speech` lookup, `isNativePlatform()` gate, listener→unsubscribe
handles). The web bundle never imports this package directly.

## Package layout

Modeled on `@ci/capacitor-local-hub` for consistency:

```
src/
  definitions.ts   # SpeechPlugin TS interface (source of truth for native parity)
  index.ts         # registerPlugin('Speech', ...)
  web.ts           # no-op web fallback (deliberately not Web Speech API)
android/
  build.gradle
  src/main/AndroidManifest.xml            # RECORD_AUDIO + TTS_SERVICE <queries>
  src/main/java/com/companionintelligence/speech/
    SpeechPlugin.kt                  # @CapacitorPlugin(name = "Speech"): call/JS translation only
    SpeechRecognitionController.kt   # three-tier SpeechRecognizer strategy, no Capacitor types
    SpeechSynthesisController.kt     # TextToSpeech lifecycle, chunking, utterance completion
  src/androidTest/java/com/companionintelligence/speech/
    SpeechControllersTest.kt         # instrumented; see "Test coverage" below
CiCapacitorSpeech.podspec            # name is DERIVED from the package name; see below
ios/
  Sources/SpeechPlugin/
    SpeechPlugin.swift               # CAPPlugin/CAPBridgedPlugin, jsName "Speech"
    SpeechRecognitionController.swift
    SpeechSynthesisController.swift
```

Consumed by `frontend/apps/mobile` via
`"@ci/capacitor-speech": "file:../../packages/capacitor-speech"`, picked up by `npx cap sync`
on the Android side.

> **The podspec filename is not free — it is derived.** `cap sync ios` **regenerates** the
> Podfile and derives each pod name from the *package* name, stripping the scope and
> camel-casing the rest: `@ci/capacitor-speech` → **`CiCapacitorSpeech`**. It then emits
>
> ```ruby
> pod 'CiCapacitorSpeech', :path => '../../../../packages/capacitor-speech'
> ```
>
> and CocoaPods looks for `CiCapacitorSpeech.podspec` in that directory. This README
> previously said the Podfile entry had to be added by hand and named the pod
> `CapacitorSpeech` — both wrong, and the second wrong in a way that **stopped iOS building
> at all** ("No podspec found for `CiCapacitorSpeech`"). Renaming the podspec to the derived
> name is the fix; do not rename it back, and do not hand-edit the Podfile, because
> `cap sync` will overwrite it.

### Yarn `file:` dependencies are copies, not symlinks

On the Windows dev setup used here, `frontend/apps/mobile/node_modules/@ci/capacitor-*` are
real **copies**, not symlinks. Editing a source file in this package does **not** reach the
Gradle build until `yarn install` is re-run inside `frontend/apps/mobile` — and Gradle will
still happily report `BUILD SUCCESSFUL` against the stale copy. After every edit here:

```bash
cd frontend/apps/mobile && yarn install && npx cap sync android
```

## Test coverage — what is and is not proven

`android/src/androidTest/.../SpeechControllersTest.kt` runs via `connectedAndroidTest`.

**Proven:**

- Tier selection for every API level 23–35 (a pure function, so it is asserted for levels
  this device does not run), including that a modern OS with no on-device service degrades to
  `best-effort` rather than claiming a guarantee.
- Error-code mapping, recoverability, and lenient BCP-47 tag matching.
- Text chunking: never exceeds the engine limit, preserves every word, hard-splits an
  unbreakable run.
- The real framework probes bind, answer, and never throw; the capability result is
  internally consistent (`best-effort` ⇒ not guaranteed; guaranteed ⇒ on-device tier).
- `TextToSpeech` actually initializes on the device, enumerates voices, and drives an
  utterance through to `onDone` (the completion plumbing behind `speak()`'s promise).

**Not proven — do not claim otherwise:**

- **That speech is transcribed correctly.** The emulator's virtual microphone is off by
  default and there is no way to speak into it from a test process. No test in this suite
  opens the microphone; `startListening()` is deliberately never called. Real recognition
  accuracy has to be checked by a human on a physical device.
- Anything about the **language-pack download** path end to end (it depends on network state
  and the system recognition service).
- **iOS speech at runtime**, entirely — see below. It now compiles and links; nothing has
  ever listened or spoken.

## iOS native implementation status — compiles, never exercised

> **Corrected 2026-08-13.** This section used to say the iOS side was written with "no Mac,
> no Xcode, and no Swift compiler", that none of the Swift had been compiled, and that
> `pod install` had not been run. That is no longer true, and leaving it in place hid a real
> build failure behind an expected one.

**What is now verified.** The branch was built on a real Mac: `pod install` resolves,
`ios/Sources/SpeechPlugin/*.swift` **compiles and links**, and the app builds clean from an
empty DerivedData (Xcode 27 / iOS 27 simulator), launches, and stays up. Getting there took
two fixes in this plugin: the podspec rename described above, and **two Swift access-level
errors in `SpeechPlugin`** that no amount of source-reading had caught.

**What is still unverified, and why it cannot be fixed here.** Everything about speech
actually working. The iOS **simulator has no microphone**, so it is no better than the
Android emulator for this — it can prove the plugin loads, not that it hears:

- **That speech is transcribed correctly.** No session has ever been started, no utterance
  spoken. Same status as Android, same blocker: a human on a physical device.
- **`supportsOnDeviceRecognition`.** The simulator reports it differently from a device, so
  the very property the `require` policy is built on is unconfirmed on real hardware. This
  is the one that matters most: it is the runtime check that decides whether the privacy
  promise can be kept or must be rejected.
- The `AVAudioSession` interaction between recognition (`.record`) and synthesis
  (`usesApplicationAudioSession = false`) is reasoned from Apple's documentation, not
  observed. A talk-then-listen loop is the case most likely to expose a mistake here.
- The 55s duration cap is a deliberate margin under Apple's documented ~1 minute; the exact
  framework behavior at the boundary was not observed.

**Four confirmed defects in this plugin are open**, surfaced by a five-lens adversarial
review of the branch and not closable without a device for the reasons above. Treat "it
compiles" as exactly that — the Swift is no longer hypothetical, but the *behaviour* still
is. On-device testing must happen before this ships.
