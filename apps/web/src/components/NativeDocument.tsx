import type {
  FileViewerOptions,
  FileViewerViewState,
  ViewerController,
  ViewerMountOptions,
} from "@file-viewer/core/browser";
import type { FileReference } from "@rei/protocol";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/primitives/button.tsx";
import { Input } from "@/components/primitives/input.tsx";
import { NativeSelect } from "@/components/primitives/native-select.tsx";
import { installNativeViewerChrome } from "../lib/nativeViewerChrome.ts";
import type { OfficePreflight, SheetInfo } from "../lib/officePreflight.ts";
import { Icon } from "./Icon.tsx";
import { Tip } from "./Tip.tsx";

export function NativeDocument({
  bytes,
  name,
  onError,
  onLocation,
}: {
  bytes: ArrayBuffer;
  name: string;
  onError: (message: string) => void;
  onLocation: (location: FileReference["location"]) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    viewer = useRef<ViewerController | null>(null);
  const errorRef = useRef(onError),
    locationRef = useRef(onLocation);
  errorRef.current = onError;
  locationRef.current = onLocation;
  const [loading, setLoading] = useState(true);
  const [zoom, setZoom] = useState<ReturnType<ViewerController["getZoomState"]>>(null);
  const [searchResult, setSearchResult] = useState<ReturnType<ViewerController["getSearchState"]>>(null);
  const [query, setQuery] = useState("");
  const [controlError, setControlError] = useState("");
  async function control(action: (controller: ViewerController) => Promise<unknown>) {
    if (!viewer.current) return;
    setControlError("");
    try {
      await action(viewer.current);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : "This document control is unavailable.");
    }
  }
  const [navigationOpen, setNavigationOpen] = useState(true);
  const [slideElements, setSlideElements] = useState<HTMLElement[]>([]),
    [slide, setSlide] = useState(1);
  const [sheets, setSheets] = useState<SheetInfo[]>([]),
    [missingResults, setMissingResults] = useState(0),
    [sheetIndex, setSheetIndex] = useState(0),
    [cell, setCell] = useState("A1");
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setQuery("");
    setZoom(null);
    setSearchResult(null);
    setControlError("");
    let worker: Worker | undefined;
    let workerTimer: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      if (/\.rtf$/i.test(name))
        throw new Error("Direct RTF rendering is not enabled. Use compatibility preview or download the original.");
      let prepared: OfficePreflight = { bytes, sheets: [], missingResults: 0 };
      if (/\.(xlsx|xltx|xlsm|xltm|xls|xlt|xlsb|docx|dotx|pptx|ppsx|potx|odt|ods|odp)$/i.test(name)) {
        worker = new Worker(new URL("../lib/officePreflight.worker.ts", import.meta.url), { type: "module" });
        prepared = await new Promise<OfficePreflight>((resolve, reject) => {
          workerTimer = setTimeout(() => {
            worker?.terminate();
            reject(new Error("Document parsing took too long. Try compatibility preview."));
          }, 15_000);
          worker!.onmessage = (event: MessageEvent<{ result?: OfficePreflight; error?: string }>) => {
            clearTimeout(workerTimer);
            worker?.terminate();
            event.data.result ? resolve(event.data.result) : reject(new Error(event.data.error));
          };
          worker!.onerror = () => {
            clearTimeout(workerTimer);
            worker?.terminate();
            reject(new Error("The document parser could not start."));
          };
          worker!.postMessage({ bytes, name });
        });
      }
      if (cancelled) return;
      setSlideElements([]);
      setSlide(1);
      setSheets(prepared.sheets);
      setMissingResults(prepared.missingResults);
      setSheetIndex(0);
      setCell("A1");
      const [{ mountViewer, setDefaultFileViewerAssetBaseUrl }, renderer] = await Promise.all([
        import("@file-viewer/core/browser"),
        /\.(xlsx?|xltx?|xlsm|xltm|xlsb|csv|tsv|ods)$/i.test(name)
          ? import("@file-viewer/renderer-spreadsheet")
          : /\.(pptx?|ppsx?|potx?)$/i.test(name)
            ? import("@file-viewer/renderer-presentation")
            : /\.pdf$/i.test(name)
              ? import("@file-viewer/renderer-pdf")
              : import("@file-viewer/renderer-word"),
      ]);
      if (cancelled || !host.current) return;
      setDefaultFileViewerAssetBaseUrl("/file-viewer/");
      if (/\.pptx$/i.test(name)) (await import("@file-viewer/capability-pptx-charts")).enableFileViewerPptxCharts();
      const mountOptions: ViewerMountOptions = {
        // Keep document paper and unstyled cell defaults unchanged; Rei themes only the surrounding chrome.
        onStateChange: (state) => {
          if (!cancelled) {
            setZoom(state.zoom);
            setSearchResult(state.search);
          }
        },
        options: {
          renderers: [renderer.default] as unknown as FileViewerOptions["renderers"],
          builtinRenderers: "none",
          autoRenderers: false,
          styleIsolation: "shadow",
          locale: "en-US",
          theme: "light",
          toolbar: false,
          search: true,
          fit: "width",
          docx: { worker: true, externalLinkPolicy: "block", externalResourcePolicy: "block", renderAltChunks: false },
          spreadsheet: { worker: true, fillViewport: true },
          presentation: { pptCache: false },
        },
        onEvent: (event: Parameters<NonNullable<ViewerMountOptions["onEvent"]>>[0]) => {
          if (event.type === "view-state-change") {
            const state = event.payload.state;
            const loc = locationOf(state, name);
            if (state.spreadsheet) {
              setSheetIndex(state.spreadsheet.sheetId ?? 0);
              if (loc?.cell) setCell(loc.cell);
            }
            locationRef.current?.(
              loc?.sheet ? { ...loc, sheet: prepared.sheets[Number(loc.sheet)]?.name ?? loc.sheet } : loc,
            );
          }
        },
      };
      const instance = mountViewer(host.current, mountOptions, {
        onError: (e) => errorRef.current(e instanceof Error ? e.message : "Direct preview is unavailable."),
      });
      viewer.current = instance;
      installNativeViewerChrome(host.current);
      await instance.load({ ...mountOptions, buffer: prepared.bytes, filename: name });
      if (!cancelled) {
        if (!instance.getApi()) throw new Error("A direct renderer is not available for this format.");
        installNativeViewerChrome(host.current!);
        setZoom(instance.getZoomState());
        setSearchResult(instance.getSearchState());
        setLoading(false);
        if (/\.(pptx|docx)$/i.test(name) && host.current)
          setSlideElements(findSlideElements(host.current, /\.docx$/i.test(name)));
        locationRef.current?.(locationOf(instance.getViewState(), name));
      }
    })().catch((e) => {
      if (!cancelled) errorRef.current(e instanceof Error ? e.message : "The document could not be rendered directly.");
    });
    return () => {
      cancelled = true;
      clearTimeout(workerTimer);
      worker?.terminate();
      const current = viewer.current;
      viewer.current = null;
      if (current) current.destroy();
    };
  }, [bytes, name]);
  const inspected = sheets[sheetIndex]?.cells[cell.toUpperCase()];
  return (
    <div className="native-document-wrap">
      {!loading && (
        <div className="native-toolbar" role="group" aria-label="Document controls">
          <Tip label="Zoom out">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom out document"
              disabled={!zoom?.canZoomOut}
              onClick={() => void control((controller) => controller.zoomOut())}
            >
              <Icon name="minus" size={16} />
            </Button>
          </Tip>
          {zoom && <output aria-label="Document zoom">{zoom.label}</output>}
          <Tip label="Zoom in">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Zoom in document"
              disabled={!zoom?.canZoomIn}
              onClick={() => void control((controller) => controller.zoomIn())}
            >
              <Icon name="plus" size={16} />
            </Button>
          </Tip>
          <Tip label="Fit to width">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!zoom}
              onClick={() => void control((controller) => controller.fitToView("width"))}
            >
              Fit
            </Button>
          </Tip>
          <form
            role="search"
            aria-label="Search document"
            onSubmit={(event) => {
              event.preventDefault();
              void control((controller) =>
                query.trim() ? controller.searchDocument(query.trim()) : controller.clearDocumentSearch(),
              );
            }}
          >
            <Input
              type="search"
              aria-label="Find in document"
              placeholder="Find in document"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Tip label="Find">
              <Button type="submit" variant="ghost" size="icon-sm" aria-label="Find in document">
                <Icon name="search" size={16} />
              </Button>
            </Tip>
            <output aria-label="Search matches" aria-live="polite">
              {searchResult?.query
                ? `${searchResult.total ? searchResult.currentIndex + 1 : 0}/${searchResult.total}`
                : ""}
            </output>
            <Tip label="Previous match">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Previous document match"
                disabled={!searchResult?.total}
                onClick={() => void control((controller) => controller.previousSearchResult())}
              >
                <Icon name="back" size={16} />
              </Button>
            </Tip>
            <Tip label="Next match">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Next document match"
                disabled={!searchResult?.total}
                onClick={() => void control((controller) => controller.nextSearchResult())}
              >
                <Icon name="forward" size={16} />
              </Button>
            </Tip>
          </form>
        </div>
      )}
      {controlError && (
        <p className="native-toolbar-error" role="alert">
          {controlError}
        </p>
      )}
      {missingResults > 0 && (
        <p className="native-formula-note" role="status">
          {missingResults} formula cell(s) have no saved result. They are marked unavailable; previews do not
          recalculate them.
        </p>
      )}
      {sheets.length > 0 && (
        <div className="native-cell-inspector" aria-label="Cell inspector">
          <NativeSelect
            aria-label="Inspect worksheet"
            value={sheetIndex}
            onChange={(e) => {
              const index = Number(e.target.value);
              setSheetIndex(index);
              void viewer.current?.applyViewState({ spreadsheet: { sheetId: index } });
            }}
          >
            {sheets.map((sheet, index) => (
              <option key={index} value={index}>
                {sheet.name}
              </option>
            ))}
          </NativeSelect>
          <Input
            aria-label="Inspect cell"
            value={cell}
            onChange={(e) => {
              const value = e.target.value.toUpperCase();
              setCell(value);
              locationRef.current?.({ sheet: sheets[sheetIndex]?.name, cell: value });
            }}
          />
          <output aria-label="Cell value">{inspected?.value ?? "(Empty cell)"}</output>
          <output aria-label="Cell formula">{inspected?.formula ? `=${inspected.formula}` : "No formula"}</output>
        </div>
      )}
      {loading && (
        <p role="status" className="native-document-loading">
          Rendering document…
        </p>
      )}
      {!!slideElements.length && (
        <Button
          variant="outline"
          type="button"
          className="native-navigation-toggle"
          aria-expanded={navigationOpen}
          onClick={() => setNavigationOpen(!navigationOpen)}
        >
          {/\.docx$/i.test(name) ? "Pages" : "Slides"}
        </Button>
      )}
      <div className="native-document-stage">
        {!!slideElements.length && navigationOpen && (
          <nav className="native-slide-rail" aria-label={/\.docx$/i.test(name) ? "Document pages" : "Slides"}>
            {slideElements.map((element, index) => (
              <Tip key={index} label={`Go to ${/\.docx$/i.test(name) ? "page" : "slide"} ${index + 1}`}>
                <Button
                  variant="outline"
                  type="button"
                  className="block h-auto min-h-0 w-full rounded-xl p-1.5 text-left"
                  key={index}
                  aria-label={`Go to ${/\.docx$/i.test(name) ? "page" : "slide"} ${index + 1}`}
                  aria-current={slide === index + 1 ? "page" : undefined}
                  onClick={() => {
                    element.scrollIntoView({ block: "start", behavior: "smooth" });
                    setSlide(index + 1);
                    locationRef.current?.(/\.docx$/i.test(name) ? { page: index + 1 } : { slide: index + 1 });
                  }}
                >
                  <span>{index + 1}</span>
                  <SlideThumbnail element={element} />
                </Button>
              </Tip>
            ))}
          </nav>
        )}
        <div className="native-document" ref={host} aria-label={`Document: ${name}`} />
      </div>
    </div>
  );
}
function locationOf(state: FileViewerViewState | null, name: string): FileReference["location"] {
  if (!state) return undefined;
  if (state.spreadsheet) {
    const range = state.spreadsheet.range;
    let cell = "";
    if (range) {
      let n = range.startCol + 1;
      while (n) {
        cell = String.fromCharCode(65 + ((n - 1) % 26)) + cell;
        n = Math.floor((n - 1) / 26);
      }
      cell += String(range.startRow + 1);
    }
    return { sheet: String(state.spreadsheet.sheetId ?? range?.sheetId ?? 0), ...(cell ? { cell } : {}) };
  }
  if (state.page !== undefined)
    return /\.(pptx?|ppsx?|potx?|odp)$/i.test(name) ? { slide: state.page } : { page: state.page };
  return undefined;
}

function findSlideElements(root: ParentNode, documentPages = false): HTMLElement[] {
  const found: HTMLElement[] = [];
  if (root instanceof HTMLElement && root.shadowRoot) found.push(...findSlideElements(root.shadowRoot, documentPages));
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (
      documentPages
        ? element.tagName === "SECTION" && element.classList.contains("docx")
        : element.classList.contains("slide")
    )
      found.push(element);
    if (element.shadowRoot) found.push(...findSlideElements(element.shadowRoot, documentPages));
  }
  return found;
}
function SlideThumbnail({ element }: { element: HTMLElement }) {
  const host = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" });
    root.replaceChildren();
    const sourceRoot = element.getRootNode() as ParentNode;
    for (const style of sourceRoot.querySelectorAll("style")) root.append(style.cloneNode(true));
    const clone = element.cloneNode(true) as HTMLElement;
    clone.setAttribute("inert", "");
    clone.setAttribute("aria-hidden", "true");
    clone.querySelectorAll("script, iframe, object, audio, video").forEach((node) => node.remove());
    const width = element.offsetWidth || 1280,
      height = element.offsetHeight || 720;
    clone.style.cssText += `;width:${width}px!important;height:${height}px!important;margin:0!important;position:absolute!important;left:0!important;top:0!important;transform:scale(${Math.min(128 / width, 76 / height)})!important;transform-origin:top left!important;pointer-events:none!important`;
    const base = document.createElement("style");
    base.textContent =
      ":host{display:block;width:128px;height:76px;position:relative;overflow:hidden;background:white;pointer-events:none}";
    root.append(base, clone);
    return () => root.replaceChildren();
  }, [element]);
  return <span ref={host} aria-hidden="true" />;
}
