// swift-tools-version:6.2
import PackageDescription

// A standalone CLI, not a library: the Rust side (apple_bridge.rs) spawns the
// built binary as a child process and talks to it over stdin/stdout, exactly
// like stack_manager.rs already shells out to `docker`. Kept out-of-process
// (rather than an FFI static-lib bridge, the pattern the ecosystem's small
// community crates use) so the Rust crate has zero unsafe Swift-interop
// surface and the helper can be built independently with `swift build`.
let package = Package(
    name: "ci-apple-bridge",
    platforms: [.macOS(.v26)],
    targets: [
        .executableTarget(
            name: "ci-apple-bridge"
        )
    ]
)
