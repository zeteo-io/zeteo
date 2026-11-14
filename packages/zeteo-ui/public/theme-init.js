// Applies the persisted (or system) theme before first paint to avoid a
// light/dark flash. A same-origin static file rather than an inline <script>,
// because the content security policy forbids inline scripts.
/* global window, document, localStorage */
(function () {
  try {
    var stored = localStorage.getItem("zeteo-theme");
    var theme = stored ? JSON.parse(stored) : "system";
    var resolved =
      theme === "system"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light"
        : theme;
    document.documentElement.setAttribute("data-theme", resolved);
  } catch {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
