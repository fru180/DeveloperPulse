# DeveloperPulse

A local-first system audio visualizer inspired by GitHub's contribution graph.

- **Live Cells** gives all 371 cells a fixed frequency, sensitivity, and pulse
  response, then colors them from live audio.
- **Timeline** keeps the original time-by-frequency contribution graph.

Both modes use the GitHub Green palette.

## Web

```sh
npm install
npm run dev
```

Open `http://localhost:3000`, select **Start visualizing**, choose a Chrome tab,
and enable **Share tab audio**. Audio is analyzed in the browser and is never
recorded or uploaded.

## macOS app

Requires macOS 13+, Rust, and Xcode Command Line Tools.

```sh
npm run tauri dev
npm run tauri build
```

The first capture requires Screen & System Audio Recording permission. Restart
DeveloperPulse after granting access. The local MVP build is unsigned.

## Checks

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Run `npm run format` to format both the web and Rust codebases.
