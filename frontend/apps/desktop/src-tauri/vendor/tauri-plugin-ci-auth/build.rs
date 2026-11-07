// Copyright (c) Lifescope Inc. Licensed under the PolyForm Noncommercial License 1.0.0; see LICENSE.md.

const COMMANDS: &[&str] = &[
    "begin_loopback",
    "await_loopback",
    "cancel_loopback",
    "secure_get",
    "secure_set",
    "secure_remove",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
