export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = Exclude<ThemePreference, "system">;

export const THEME_STORAGE_KEY = "codex-everywhere.theme";

const THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#f4f5f7",
  dark: "#101216",
};

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }
  return preference;
}

export function themeColor(theme: ResolvedTheme): string {
  return THEME_COLORS[theme];
}

export function themePreferenceLabel(preference: ThemePreference): string {
  switch (preference) {
    case "light":
      return "浅色模式";
    case "dark":
      return "深色模式";
    case "system":
      return "跟随系统";
  }
}

export type ThemeController = {
  getPreference(): ThemePreference;
  setPreference(preference: ThemePreference): void;
};

export function initializeTheme(): ThemeController {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference = readStoredPreference();

  const apply = (): void => {
    const resolved = resolveTheme(preference, media.matches);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = resolved;
    const meta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    if (meta) meta.content = themeColor(resolved);
  };

  const handleSystemThemeChange = (): void => {
    if (preference === "system") apply();
  };
  media.addEventListener("change", handleSystemThemeChange);

  window.addEventListener("storage", (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    preference = normalizeThemePreference(event.newValue);
    apply();
  });

  apply();

  return {
    getPreference: () => preference,
    setPreference: (nextPreference) => {
      preference = normalizeThemePreference(nextPreference);
      try {
        window.localStorage.setItem(THEME_STORAGE_KEY, preference);
      } catch {
        // Theme selection still applies for the current page when storage is unavailable.
      }
      apply();
    },
  };
}

function readStoredPreference(): ThemePreference {
  try {
    return normalizeThemePreference(
      window.localStorage.getItem(THEME_STORAGE_KEY),
    );
  } catch {
    return "system";
  }
}
