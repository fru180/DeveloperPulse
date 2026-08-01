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

function runThemeInitializer(savedTheme, storageThrows = false) {
  const root = { dataset: {}, style: {} };
  const meta = {
    content: "#f6f8fa",
    setAttribute(name, value) { this[name] = value; },
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
    "#eff2f5", "#aceebb", "#4ac26b", "#2da44e", "#116329",
  ]);
  assert.deepEqual(VISUALIZER_PALETTES.dark.levels, [
    "#151b23", "#033a16", "#196c2e", "#2ea043", "#56d364",
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
