# @ci/capacitor-app-lock

Capacitor plugin for the **biometric app lock** in the CI-Server mobile apps. Both native
halves ship here (Android in Kotlin, iOS in Swift), like `@ci/capacitor-local-hub`.

The design it implements is `frontend/apps/{ios,android}/SECURITY_ARCHITECTURE.md` § 4.
In one paragraph: the lock **state lives natively**, so a cold start comes up locked before
the WebView has drawn anything; a **native view above the WebView** is the lock screen
(the doc's "v2"), and the web app's own route gate merely mirrors the native state ("v1");
the prompt is the **OS one with passcode fallback**; the task switcher shows **nothing**
(`FLAG_SECURE` on Android, a blur on iOS); and **sync keeps running behind the lock** —
no database key is ever tied to the prompt, which is why the outbox and PowerSync do not
stop when the screen does.

## Surface

```ts
interface AppLockPlugin {
  getStatus(): Promise<AppLockStatus>;
  configure(settings: Partial<AppLockSettings>): Promise<AppLockStatus>; // enabling runs the prompt once first
  lock(): Promise<AppLockStatus>;
  unlock(): Promise<AppLockStatus>; // resolves with locked: true on cancel; never rejects
  setLockScreenNote(options: { text: string }): Promise<void>; // "3 captures waiting to sync"
  addListener('lockStateChange', (e: { locked: boolean }) => void): Promise<PluginListenerHandle>;
}
```

`AppLockSettings` = `{ enabled, grace: 'immediately' | '30s' | '5m' | 'never', secureScreen }`,
persisted natively (SharedPreferences / UserDefaults). `AppLockStatus` adds `locked`,
`available`, `biometry: 'strong' | 'weak' | 'credential-only' | 'none'` and a `reason`.

## Lifecycle

| Trigger | Behaviour |
|---|---|
| Cold start, lock on | Locked; overlay shown in `load()`; the prompt opens on the first resume |
| Leaves the foreground | Timestamp taken; `immediately` locks at once; Android `FLAG_SECURE` / iOS blur hide the page from the switcher |
| Returns | Locked if the time away reached the grace (`never` only locks on launch / `lock()`); a locked app prompts at once |
| Prompt passes | Unlocked; overlay removed; `lockStateChange { locked: false }` |
| Prompt cancelled / fails | Stays locked; the overlay's own Unlock button retries; the OS rate-limits attempts |
| `configure({ enabled: true })` | Runs the prompt first; only a pass enables, so nobody enables a lock they cannot pass |

## Platform notes

- **Android:** `androidx.biometric` `BiometricPrompt` with `BIOMETRIC_STRONG | DEVICE_CREDENTIAL`
  (API 30+; `BIOMETRIC_WEAK | DEVICE_CREDENTIAL` below, where the strong+credential set is
  not allowed). No negative button, as the credential set requires. `USE_BIOMETRIC` is
  declared in this module's manifest. The overlay is added to the window's decor view.
- **iOS:** `LAContext.evaluatePolicy(.deviceOwnerAuthentication, …)`, never the
  `WithBiometrics` variant. The host app must carry `NSFaceIDUsageDescription`. The overlay
  and the blur are added to the bridge view controller's view.
- **Web:** reports `available: false`; the web app hides the feature.

## Tests

`android/src/test` holds JVM tests for the lock rules (`AppLockPolicy`) and the wire mapping,
including a check that every `Grace` value is a member of the TypeScript union. Run them with
`make test-android`. The prompt, the overlay and the window flag need a device.
