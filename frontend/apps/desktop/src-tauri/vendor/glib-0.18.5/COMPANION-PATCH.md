Companion Memory compatibility patch
====================================

This directory is the crates.io glib 0.18.5 source, kept vendored because the
current Tauri/GTK3 dependency graph requires the 0.18 API. The only source change
is the upstream VariantStrIter::impl_get fix from gtk-rs/gtk-rs-core commit
b5a4071e439bef2b5eea76c3aa25e5ae84839e34:

https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34

The fix passes a mutable pointer reference to g_variant_get_child, which writes
the child string pointer. This backport can be removed when the Tauri/GTK3
dependency graph can move to glib 0.20 or later.

The vendored tree otherwise matches the crates.io glib 0.18.5 archive. Its
archive checksum is the checksum recorded in the pre-patch Cargo.lock entry.
