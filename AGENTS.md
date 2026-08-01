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

```sh
npm run tauri dev
npm run tauri build
```

The first system-audio capture requires Screen & System Audio Recording permission. Restart DeveloperPulse after granting access. Development builds are unsigned.

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
