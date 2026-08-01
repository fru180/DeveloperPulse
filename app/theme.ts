export type Theme = "light" | "dark";

export const DEFAULT_THEME: Theme = "light";
export const THEME_STORAGE_KEY = "developer-pulse-theme";

export const THEME_META_COLORS: Record<Theme, string> = {
  light: "#f6f8fa",
  dark: "#010409",
};

export const VISUALIZER_PALETTES = {
  light: {
    levels: ["#eff2f5", "#aceebb", "#4ac26b", "#2da44e", "#116329"],
  },
  dark: {
    levels: ["#151b23", "#033a16", "#196c2e", "#2ea043", "#56d364"],
  },
} as const satisfies Record<
  Theme,
  {
    levels: readonly [string, string, string, string, string];
  }
>;

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}
