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
