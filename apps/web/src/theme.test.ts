import { describe, expect, it } from "vitest";

import {
  normalizeThemePreference,
  resolveTheme,
  themeColor,
  themePreferenceLabel,
} from "./theme.js";

describe("theme preference", () => {
  it("defaults invalid or missing values to the system preference", () => {
    expect(normalizeThemePreference(null)).toBe("system");
    expect(normalizeThemePreference("sepia")).toBe("system");
    expect(normalizeThemePreference("dark")).toBe("dark");
  });

  it("resolves system mode whenever the operating-system preference changes", () => {
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("provides matching browser chrome colors and visible labels", () => {
    expect(themeColor("light")).toBe("#f4f5f7");
    expect(themeColor("dark")).toBe("#101216");
    expect(themePreferenceLabel("system")).toBe("跟随系统");
    expect(themePreferenceLabel("dark")).toBe("深色模式");
  });
});
