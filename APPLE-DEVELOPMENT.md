# Apple development

Open **Apple development** in the workbench navigation. Requires macOS and an
installed, selected Xcode toolchain. “Check Xcode and discover projects” reports
Xcode, Swift, SourceKit-LSP, LLDB, simctl and devicectl availability. It searches
five directory levels for projects, workspaces and Package.swift, skips symlinks
and common dependency/build directories, and caps traversal at 5,000 entries.

## Project setup and editing

Select an Xcode project/workspace or Swift package and trust its commands before
loading metadata. Queries can resolve dependencies and load package manifests.
Choose a scheme or a project target, configuration and destination. Xcode tests
require a scheme and explicit destination; direct targets support builds.
Swift package builds optionally select a target; tests run the package test suite.
Swift package configuration maps to debug/release.

Swift highlighting and snippets include SwiftUI views/previews, async functions
and XCTest cases. “Configure SourceKit-LSP” selects Swift and opens Language
services at the package folder (including nested packages). Connect the server
explicitly; diagnostics, completion, hover, definition and formatting depend on
advertised server capabilities.

For Xcode projects, install [xcode-build-server](https://github.com/SolaWing/xcode-build-server)
separately. Build the selected scheme in AfterEdit, prepare its build-server
configuration, review/run the command and connect SourceKit-LSP at the project
root. The configuration names AfterEdit's DerivedData as `--build_root` and may
update an existing buildServer.json. Reconfigure and rebuild after changing
scheme/destination/toolchain. This third-party bridge is not bundled or installed
automatically; its live compatibility was not verified in this pass.

## Builds, tests and results

Prepare build/tests, review the literal executable/argument arrays, then run.
Changing the selection invalidates the review. Unsaved project buffers block
execution. Logs remain available while switching workbench views. Stop terminates
the active task; project-root changes prevent subsequent steps from starting but
an already-running command may finish. The native runner permits one task globally.

Xcode scheme builds use `.afteredit/apple/DerivedData`; direct target builds use
`.afteredit/apple/Products` and `Intermediates`. Result bundles have unique names
under `.afteredit/apple/results`. Read test results uses xcresulttool's test-summary
API (recent Xcode required); compiler/test output remains readable if a result
bundle or summary is unavailable. Build diagnostics within the opened root are
clickable and appear in the editor. Consider ignoring `.afteredit/apple/` in your
project's Git configuration.

“Read product settings” finds built app/executable paths and bundle identifiers.
Only outputs inside the project can be selected automatically. Build with the
same scheme/configuration/destination before installing its product.

## Simulators, devices and debugging

Refresh simulators, choose a specific available device and prepare boot, shutdown,
install or launch. Boot waits for readiness and opens Simulator. Install takes a
built simulator `.app`; launch uses its bundle ID. There are no erase/delete
controls in the workbench.

Physical devices are discovered through devicectl's JSON report. Pair them and
enable Developer Mode with Xcode. Review install, launch or console commands for
the selected device. Use a signed device build; simulator binaries cannot run on
a physical device. Console launch can run until stopped or its one-hour limit.

Select a product or enter its relative executable path to configure LLDB. Local
Swift/macOS executables can launch directly. Launch simulator apps using simctl,
then use the reported PID for local attach. Device attach uses the selected
CoreDevice identifier and the app's PID. The debugger configuration opens for
review; it does not start until its existing trust/start controls are used.
Device and simulator attach have not been verified live in this pass.

## Signing and distribution

Choose project settings, automatic/manual signing or unsigned builds. Team,
profile and certificate overrides are explicit. “Allow Xcode to update provisioning
profiles and contact Apple” adds `-allowProvisioningUpdates`; it is off initially.
Xcode manages Apple accounts, keychain certificates, capabilities and registration.

Archives require a scheme, signing and a macOS or generic-device destination.
Use new archive/export paths to preserve earlier artifacts. Generate export options
for a local export; manual signing accepts a bundle-ID-to-profile map for app
extensions too. Save the reviewed plist as a new file inside the project, or use
an existing plist. Export reviews its contents and rechecks for changes before
starting; an upload destination is rejected. Distribution methods available for
an archive depend on its platform and installed Xcode. Signed archive/export,
provisioning updates and App Store distribution were not exercised here.

## Xcode designers

Open the project or current file in Xcode for SwiftUI Canvas, Interface Builder,
asset catalogs, accounts and signing capabilities. These are native Xcode handoffs,
not embedded preview/design surfaces. Save first; AfterEdit's existing external
file-change checks handle edits made in Xcode. Native designer UI interaction
requires hands-on verification.

## Verification

- `npm test`: command planning, parsing, argument validation and existing unit tests.
- `npm run test:a11y`: Apple workflow browser tests plus workbench regressions.
- `npm run test:release`: production startup and Apple workflow browser tests.
- `cargo test --manifest-path src-tauri/Cargo.toml`: native scope/export checks.
- `npm run test:apple`: a temporary Xcode project builds and runs XCTest on macOS,
  reads its xcresult summary and checks product paths. Uses unsigned local builds.
- `npm run test:apple:simulator`: opt-in temporary simulator creation, boot,
  fixture build/install/launch, then shutdown/deletion of that temporary device.
- `xcrun swift test --package-path fixtures/apple`: real Swift package fixture.
- `cargo test --manifest-path src-tauri/Cargo.toml sourcekit_swift_diagnostics -- --ignored`:
  real SourceKit-LSP diagnostics for an unsaved Swift error.
- `cargo test --manifest-path src-tauri/Cargo.toml swift_breakpoint_stack_variables_and_step -- --ignored`:
  real Swift LLDB launch/breakpoint/variable/evaluation/step/exit.
- `cargo test --manifest-path src-tauri/Cargo.toml native_xcode_metadata -- --ignored`:
  native command wrapper reads the fixture's schemes.

The unit suite passed 72 tests; the native suite passed 24 tests with five opt-in
live tests skipped by default. All 17 development and 10 production browser tests
passed. The macOS
release app bundle built successfully at
`src-tauri/target/release/bundle/macos/AfterEdit.app`.

The browser tests mock native IPC and do not prove native desktop accessibility.
This host has Xcode 26.3 and macOS 15.7.4. Swift package XCTest, SourceKit diagnostics,
Swift LLDB, native Xcode metadata, macOS Xcode XCTest and result/product checks
passed. No physical device was connected. The isolated iOS simulator check timed
out after five minutes during boot; its temporary device was successfully removed.
Simulator build/install/launch and attach remain unverified on this host. Signed
archive/export and physical-device execution require separate verification with
the appropriate credentials and hardware.

References: [Apple command-line tools](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference),
[SourceKit-LSP](https://github.com/swiftlang/sourcekit-lsp),
[LLDB DAP configuration](https://github.com/llvm/llvm-project/blob/main/lldb/tools/lldb-dap/README.md).
Command syntax was also checked against this installation's xcodebuild, devicectl,
xcresulttool and xed help.
