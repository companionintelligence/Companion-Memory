`glib-0.18.5` is vendored from crates.io to carry the upstream soundness fix
from [gtk-rs/gtk-rs-core#1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343),
commit [`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34).
GTK3 bindings used by this Tauri release require glib 0.18, while the upstream
release containing the fix is glib 0.20.

The crates.io source archive SHA-256 is
`233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`, matching
the original `Cargo.lock` checksum. The sole source change is the upstream
`VariantStrIter::impl_get` fix: pass the C out-pointer as `&mut p`.

Remove this patch and vendor copy when the GTK/Tauri dependency chain can use
glib 0.20 or later.

## tauri-plugin-ci-auth

`tauri-plugin-ci-auth/` is vendored from CI-Common `main` at commit
`7469629112febb12583813ac4ce67f9f85fbf90c` (#479), tree
`b42eca1260a2887437673c4d625522935b52589f` (`packages/tauri-plugin-ci-auth`). The Companion Hub
vendors the same commit. The copy differs from CI-Common in two ways:

- The copyright header in each file, and `license` in `Cargo.toml`, name PolyForm Noncommercial
  1.0.0 as the rest of this repo does (#3398). CI-Common's own headers say "Private &
  Confidential" and `UNLICENSED`.
- The phone half of the plugin (`android/`, `ios/` and `src/mobile.rs`) is left out. It compiles
  only for iOS and Android targets, and this desktop app builds for neither.

Every other line matches CI-Common at that commit. The desktop device key uses the plugin's
`secure_get`, `secure_set` and `secure_remove` commands (see
`frontend/packages/common/src/utils/nativeBridge.ts`). The app doesn't call its loopback sign-in
commands, so the page that sign-in serves in the browser is not shown to anyone yet.

Its pins are `tauri = "=2.12.5"` and `tauri-build = "=2.7.4"`, the versions this app already
resolves. Move them together with the Companion Hub's pins: bump `tauri` and `tauri-build` in the
plugin and in this crate's `Cargo.toml` in the same change.

To re-vendor, copy `packages/tauri-plugin-ci-auth` from a newer CI-Common commit, leave out the
phone files again, put this repo's license headers back and update the commit and tree above.
