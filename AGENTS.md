# Development guide

## Requirements

- Node.js 22.13.0 or later
- macOS 13 or later for the desktop app
- Rust and Xcode Command Line Tools for desktop development

## Setup

```sh
npm install
```

## Engineering principles

- Always obtain the user's approval before changing direction from the original plan.
- When considering improvements, pursue a root-cause solution instead of an ad hoc minimal fix.
- When implementing tests, cover the necessary and sufficient scenarios without writing tests that over-constrain behavior.

## Web development

```sh
npm run dev
```

The development server is available at `http://localhost:3000`.

## Desktop development

### Hot reload

```sh
npm run tauri dev
```

Use `tauri dev` for UI development and hot reload. On macOS 26 or later it launches a plain executable that does not appear in **System Settings > Privacy & Security > Screen & System Audio Recording**, so do not use it to verify TCC or system-audio permissions.

### System-audio permission testing

Quit DeveloperPulse before starting. For every rebuilt development app, run the complete sequence:

```sh
npm run tauri build -- --debug --bundles app
bundle_id="$(node -p "require('./src-tauri/tauri.conf.json').identifier")"
tccutil reset ScreenCapture "$bundle_id"
open -n src-tauri/target/debug/bundle/macos/DeveloperPulse.app
```

After launch, select **Visualize audio** and allow **Screen & System Audio Recording** in the macOS prompt. The app appears in the privacy list as **DeveloperPulse**, not `developer-pulse`.

If `tccutil` reports `No such bundle identifier` on the first run, open the debug `.app` once, quit it, then rerun the reset and open commands. Run the reset only as a manual development step; do not include it in automated checks.

Development bundles are ad-hoc signed, so rebuilding changes their designated requirement and requires the full reset-and-authorize sequence again. Stable development signing is tracked in [issue #14](https://github.com/fru180/DeveloperPulse/issues/14).

### Release build

```sh
npm run tauri build
```

The first system-audio capture requires Screen & System Audio Recording permission. Restart DeveloperPulse after granting access.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Format the web and Rust codebases with:

```sh
npm run format
```
