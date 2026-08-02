import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import {
  DEFAULT_THEME,
  isTheme,
  THEME_META_COLORS,
  THEME_STORAGE_KEY,
  VISUALIZER_PALETTES,
} from "../app/theme.ts";

const themeInitSource = await readFile(
  new URL("../public/theme-init.js", import.meta.url),
  "utf8",
);
const globalsCssSource = await readFile(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
);
const developerPulseSource = await readFile(
  new URL("../app/DeveloperPulse.tsx", import.meta.url),
  "utf8",
);

function runThemeInitializer(savedTheme, storageThrows = false) {
  const root = { dataset: {}, style: {} };
  const meta = {
    content: "#f6f8fa",
    setAttribute(name, value) {
      this[name] = value;
    },
  };
  const localStorage = {
    getItem() {
      if (storageThrows) throw new Error("Storage unavailable");
      return savedTheme;
    },
  };
  vm.runInNewContext(themeInitSource, {
    window: { localStorage },
    document: {
      documentElement: root,
      querySelector: () => meta,
    },
  });
  return { root, meta };
}

test("defaults to light and accepts only supported saved themes", () => {
  assert.equal(DEFAULT_THEME, "light");
  assert.equal(THEME_STORAGE_KEY, "developer-pulse-theme");
  assert.equal(isTheme("light"), true);
  assert.equal(isTheme("dark"), true);
  assert.equal(isTheme("auto"), false);
  assert.equal(isTheme(null), false);
});

test("uses the current GitHub Primer theme and contribution colors", () => {
  assert.deepEqual(THEME_META_COLORS, {
    light: "#f6f8fa",
    dark: "#010409",
  });
  assert.deepEqual(VISUALIZER_PALETTES.light.levels, [
    "#eff2f5",
    "#aceebb",
    "#4ac26b",
    "#2da44e",
    "#116329",
  ]);
  assert.deepEqual(VISUALIZER_PALETTES.dark.levels, [
    "#151b23",
    "#033a16",
    "#196c2e",
    "#2ea043",
    "#56d364",
  ]);
});

test("initializes light by default and restores only a saved dark theme", () => {
  for (const savedTheme of [null, "auto", "invalid"]) {
    const { root, meta } = runThemeInitializer(savedTheme);
    assert.equal(root.dataset.theme, "light");
    assert.equal(root.style.colorScheme, "light");
    assert.equal(meta.content, "#f6f8fa");
  }

  const { root, meta } = runThemeInitializer("dark");
  assert.equal(root.dataset.theme, "dark");
  assert.equal(root.style.colorScheme, "dark");
  assert.equal(meta.content, "#010409");
});

test("falls back to light when theme storage is unavailable", () => {
  const { root, meta } = runThemeInitializer(null, true);
  assert.equal(root.dataset.theme, "light");
  assert.equal(root.style.colorScheme, "light");
  assert.equal(meta.content, "#f6f8fa");
});

test("places horizontal axis values above the grid and meaning below it", () => {
  assert.match(globalsCssSource, /\.canvas-stage\s*\{[^}]*display:\s*grid;/s);
  assert.doesNotMatch(globalsCssSource, /(?:^|\n)\.timeline\s*\{/);
  assert.match(
    globalsCssSource,
    /\.graph-value-axis\s*\{[^}]*display:\s*flex;/s,
  );
  assert.match(globalsCssSource, /\.graph-footer\s*\{[^}]*display:\s*flex;/s);
  assert.match(
    developerPulseSource,
    /className=\{`graph-value-axis \$\{mode\}`\}[\s\S]*−\{TIMELINE_WINDOW_SECONDS\} sec[\s\S]*TIMELINE_INTERMEDIATE_TICKS\.map[\s\S]*Now[\s\S]*<canvas[\s\S]*className="axis-name"[\s\S]*"Time"/,
  );
});

test("groups the theme and accessible display mode controls at the bottom-right", () => {
  assert.match(
    developerPulseSource,
    /<fieldset className="mode-control">[\s\S]*<legend className="visually-hidden">Display mode<\/legend>[\s\S]*type="radio"[\s\S]*value="live-cells"[\s\S]*type="radio"[\s\S]*value="timeline"[\s\S]*<\/fieldset>/,
  );
  assert.doesNotMatch(developerPulseSource, /className="select-control"/);
  assert.match(
    globalsCssSource,
    /\.display-controls\s*\{[^}]*margin:\s*0 0 0 auto;[^}]*display:\s*inline-flex;/s,
  );
  assert.match(
    globalsCssSource,
    /\.mode-option input:checked \+ span\s*\{[^}]*background:\s*var\(--accent\);/s,
  );
  assert.match(
    globalsCssSource,
    /@media\s*\(max-width:\s*720px\)[\s\S]*\.display-controls\s*\{[^}]*order:\s*4;/s,
  );
});
