import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DesktopWindowFitCoordinator } from "../app/desktop-window-fit.ts";

const tauriConfig = JSON.parse(
  await readFile(
    new URL("../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  ),
);
const globalsCssSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const developerPulseSource = await readFile(
  new URL("../app/DeveloperPulse.tsx", import.meta.url),
  "utf8",
);
const desktopCapability = JSON.parse(
  await readFile(
    new URL("../src-tauri/capabilities/default.json", import.meta.url),
    "utf8",
  ),
);
test("uses the compact desktop window dimensions", () => {
  const [window] = tauriConfig.app.windows;
  assert.equal(window.width, 864);
  assert.equal(window.height, 330);
  assert.equal(window.minWidth, 720);
  assert.equal("minHeight" in window, false);
});

test("keeps compact desktop controls on one row at the minimum width", () => {
  assert.match(
    globalsCssSource,
    /@media\s*\(max-width:\s*720px\)[\s\S]*\.desktop-app-shell \.controls\s*\{[^}]*flex-wrap:\s*nowrap;/s,
  );
  assert.match(
    globalsCssSource,
    /\.desktop-app-shell \.range-control\s*\{[^}]*order:\s*initial;/s,
  );
  assert.match(
    globalsCssSource,
    /\.desktop-app-shell \.display-controls\s*\{[^}]*order:\s*initial;/s,
  );
});

test("uses equal compact outer padding in the desktop layout", () => {
  assert.match(
    globalsCssSource,
    /\.desktop-app-shell\s*\{[^}]*padding:\s*12px;/s,
  );
});

test("prevents desktop overflow from changing the responsive viewport width", () => {
  assert.match(
    globalsCssSource,
    /html:has\(\.desktop-app-shell\),\s*body:has\(\.desktop-app-shell\)\s*\{[^}]*overflow:\s*hidden;/s,
  );
});

test("invalidates stale desktop fits when only the viewport width changes", () => {
  const coordinator = new DesktopWindowFitCoordinator();
  const firstGeneration = coordinator.beginLayoutChange();
  const firstRequest = coordinator.capture(firstGeneration, 721, 330);
  assert.ok(firstRequest);

  const secondGeneration = coordinator.beginLayoutChange();
  const secondRequest = coordinator.capture(secondGeneration, 720, 330);
  assert.ok(secondRequest);

  assert.equal(coordinator.isCurrent(firstRequest, 721), false);
  assert.equal(coordinator.isCurrent(secondRequest, 720), true);
  assert.equal(coordinator.isCurrent(secondRequest, 721), false);
});

test("fits the desktop window and minimum height to its content", () => {
  assert.match(
    globalsCssSource,
    /\.desktop-app-shell\s*\{[^}]*min-height:\s*0;[^}]*padding:\s*12px;/s,
  );
  assert.match(developerPulseSource, /new ResizeObserver\(scheduleWindowFit\)/);
  assert.match(
    developerPulseSource,
    /Math\.max\([\s\S]*appShell\.scrollHeight,[\s\S]*appShell\.getBoundingClientRect\(\)\.height/,
  );
  assert.match(
    developerPulseSource,
    /currentSize\.height\s*-\s*window\.innerHeight/,
  );
  assert.match(
    developerPulseSource,
    /fitRequest\.contentHeight\s*\+\s*windowChromeHeight/,
  );
  assert.match(developerPulseSource, /appWindow\.setMinSize/);
  assert.match(developerPulseSource, /appWindow\.setSize/);
  assert.ok(
    desktopCapability.permissions.includes("core:window:allow-set-min-size"),
  );
  assert.ok(
    desktopCapability.permissions.includes("core:window:allow-set-size"),
  );
});

test("overlays desktop errors on the graph without changing web error flow", () => {
  assert.match(
    developerPulseSource,
    /aria-hidden=\{desktop && error \? true : undefined\}/,
  );
  assert.match(
    developerPulseSource,
    /\{desktop && captureErrorContent && \([\s\S]*className="canvas-error-overlay"[\s\S]*\)\}/,
  );
  assert.match(developerPulseSource, /\{!desktop && captureErrorContent\}/);
  assert.match(
    globalsCssSource,
    /\.desktop-app-shell \.canvas-error-overlay\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;/s,
  );
  assert.match(
    globalsCssSource,
    /\.desktop-app-shell \.canvas-error-overlay \.permission-card\s*\{[^}]*border-color:\s*var\(--warning-border\);[^}]*background:\s*var\(--warning-muted\);[^}]*box-shadow:\s*inset 3px 0 0 var\(--warning\);/s,
  );
});

test("uses a distinct warning palette for permission guidance", () => {
  assert.match(
    globalsCssSource,
    /:root\s*\{[^}]*--warning:\s*#9a6700;[^}]*--warning-muted:\s*#fff8c5;[^}]*--warning-border:\s*#d4a72c;/s,
  );
  assert.match(
    globalsCssSource,
    /:root\[data-theme="dark"\]\s*\{[^}]*--warning:\s*#d29922;[^}]*--warning-muted:\s*#bb800926;[^}]*--warning-border:\s*#bb8009;/s,
  );
});

test("uses compact text for desktop permission actions", () => {
  assert.match(
    globalsCssSource,
    /\.desktop-app-shell \.canvas-error-overlay \.permission-actions button\s*\{[^}]*font-size:\s*var\(--font-size-small\);/s,
  );
  assert.match(developerPulseSource, /: "Restart"\}/);
  assert.doesNotMatch(developerPulseSource, /Restart & try again/);
});

test("debounces and directionally orders desktop window fitting", () => {
  assert.match(developerPulseSource, /DESKTOP_RESIZE_DEBOUNCE_MS = 100/);
  assert.match(
    developerPulseSource,
    /window\.setTimeout\([\s\S]*DESKTOP_RESIZE_DEBOUNCE_MS\)/,
  );
  assert.match(
    developerPulseSource,
    /heightDifference > DESKTOP_RESIZE_TOLERANCE[\s\S]*setSize\(targetSize\)[\s\S]*setMinSize\(targetMinSize\)[\s\S]*heightDifference < -DESKTOP_RESIZE_TOLERANCE[\s\S]*setMinSize\(targetMinSize\)[\s\S]*setSize\(targetSize\)/,
  );
});
