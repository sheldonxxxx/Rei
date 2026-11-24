// Runs before the first paint (a classic script in <head>, so the page never flashes the wrong colours): puts the saved
// light/dark choice on <html>. Keep the key and the logic in step with src/lib/theme.tsx.
(() => {
  var mode = "auto";
  try {
    var m = localStorage.getItem("rei:mode");
    if (m === "light" || m === "dark") mode = m;
  } catch {
    // storage blocked: the default applies
  }
  var dark =
    mode === "dark" ||
    (mode === "auto" && !!window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  var root = document.documentElement;
  root.dataset.scheme = dark ? "dark" : "light";
  root.dataset.mode = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#1c1a19" : "#f7f5f1");
})();
