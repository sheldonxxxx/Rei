import chrome from "../styles/native-viewer.css?raw";

/** Source-verified chrome selectors for the pinned @file-viewer renderers. No document/cell selectors. */
export function installNativeViewerChrome(host: HTMLElement): void {
  const visit = (root: ParentNode) => {
    if (root instanceof ShadowRoot && !root.querySelector("style[data-rei-viewer-chrome]")) {
      const style = document.createElement("style");
      style.dataset.reiViewerChrome = "";
      style.textContent = chrome;
      root.append(style);
    }
    for (const element of root.querySelectorAll<HTMLElement>("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  if (host.shadowRoot) visit(host.shadowRoot);
  visit(host);
}
