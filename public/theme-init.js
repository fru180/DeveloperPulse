(() => {
  const storageKey = "developer-pulse-theme";
  let theme = "light";

  try {
    const savedTheme = window.localStorage.getItem(storageKey);
    if (savedTheme === "light" || savedTheme === "dark") theme = savedTheme;
  } catch {
    // Keep the light default when storage is unavailable.
  }

  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) {
    themeColor.setAttribute(
      "content",
      theme === "dark" ? "#010409" : "#f6f8fa",
    );
  }
})();
