// Copyright (c) Lifescope Inc. All rights reserved.
// Private & Confidential — Property of Lifescope Inc. Do not distribute.

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
