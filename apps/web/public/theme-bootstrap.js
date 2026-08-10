(() => {
  let preference = "system";
  try {
    const stored = localStorage.getItem("codex-everywhere.theme");
    if (stored === "light" || stored === "dark") preference = stored;
  } catch {
    // Private browsing may disable storage; system mode still works.
  }
  const systemDark = matchMedia("(prefers-color-scheme: dark)").matches;
  const theme =
    preference === "dark" || (preference === "system" && systemDark)
      ? "dark"
      : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
  document.getElementById("theme-color").content =
    theme === "dark" ? "#101216" : "#f4f5f7";
})();
