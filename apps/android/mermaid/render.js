// Draws one Mermaid diagram for the Android app. The app calls `reiRender(source, themeVariables)` with both values as
// JSON, and hears back through the `reiMermaid` message channel: the drawn height in CSS pixels (dp), a syntax error,
// or that Mermaid is missing from the build. Strict security and plain-text labels, the same settings as the web client.
(() => {
  const box = document.getElementById("diagram");
  const post = (message) => {
    if (typeof reiMermaid !== "undefined") reiMermaid.postMessage(JSON.stringify(message));
  };
  let sequence = 0;
  let reported = -1;
  const report = () => {
    if (!box.firstElementChild) return;
    const height = Math.ceil(box.getBoundingClientRect().height);
    if (height === reported) return;
    reported = height;
    post({ kind: "drawn", height });
  };
  new ResizeObserver(report).observe(box);

  window.reiRender = async (source, themeVariables) => {
    const id = ++sequence;
    if (typeof mermaid === "undefined") {
      post({ kind: "unavailable" });
      return;
    }
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
        theme: "base",
        themeVariables,
      });
      const { svg } = await mermaid.render(`rei${id}`, source);
      if (id !== sequence) return;
      // Mermaid's strict security level sanitizes the SVG it returns.
      box.innerHTML = svg;
      reported = -1;
      report();
    } catch {
      document.getElementById(`drei${id}`)?.remove();
      if (id === sequence) post({ kind: "error" });
    }
  };
})();
