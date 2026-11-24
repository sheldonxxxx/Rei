import type { ViewerMountOptions } from "@file-viewer/core/browser";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NativeDocument } from "./NativeDocument.tsx";

const native = vi.hoisted(() => {
  const zoom = { scale: 1, label: "100%", canZoomIn: true, canZoomOut: true, canReset: true };
  const search = { query: "", total: 0, currentIndex: -1, current: null, matches: [] };
  return {
    zoom,
    search,
    options: null as ViewerMountOptions | null,
    load: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
    zoomIn: vi.fn().mockResolvedValue(null),
    zoomOut: vi.fn().mockResolvedValue(null),
    fitToView: vi.fn().mockResolvedValue(null),
    searchDocument: vi.fn().mockResolvedValue(null),
    clearDocumentSearch: vi.fn().mockResolvedValue(null),
    nextSearchResult: vi.fn().mockResolvedValue(null),
    previousSearchResult: vi.fn().mockResolvedValue(null),
  };
});
vi.mock("@file-viewer/core/browser", () => ({
  setDefaultFileViewerAssetBaseUrl: vi.fn(),
  mountViewer: (host: HTMLElement, options: ViewerMountOptions) => {
    native.options = options;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      '<div class="file-viewer-web-shell"><article style="color:rgb(180,0,0);background:white">Original document</article></div>';
    return {
      ...native,
      getApi: () => ({}),
      getViewState: () => null,
      getZoomState: () => native.zoom,
      getSearchState: () => native.search,
    };
  },
}));
vi.mock("@file-viewer/renderer-pdf", () => ({ default: {} }));

beforeEach(() => vi.clearAllMocks());

describe("NativeDocument controls", () => {
  it("provides accessible zoom, fit, search and match navigation while preserving the document", async () => {
    const bytes = new ArrayBuffer(8),
      onError = vi.fn();
    const view = render(<NativeDocument bytes={bytes} name="report.pdf" onError={onError} onLocation={() => {}} />);
    await screen.findByRole("group", { name: "Document controls" });
    expect(native.load).toHaveBeenCalledWith(
      expect.objectContaining({
        buffer: bytes,
        filename: "report.pdf",
        options: expect.objectContaining({ toolbar: false }),
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Zoom in document" }));
    await waitFor(() => expect(native.zoomIn).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    await waitFor(() => expect(native.fitToView).toHaveBeenCalledWith("width"));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find in document" }), { target: { value: "budget" } });
    fireEvent.submit(screen.getByRole("search", { name: "Search document" }));
    await waitFor(() => expect(native.searchDocument).toHaveBeenCalledWith("budget"));
    act(() =>
      native.options?.onStateChange?.({
        loading: false,
        ready: true,
        error: null,
        lastEvent: null,
        lifecycle: null,
        availability: null,
        location: null,
        zoom: native.zoom,
        search: { ...native.search, query: "budget", total: 2, currentIndex: 0 },
      }),
    );
    expect(screen.getByRole("status", { name: "Search matches" }).textContent).toBe("1/2");
    fireEvent.click(screen.getByRole("button", { name: "Next document match" }));
    await waitFor(() => expect(native.nextSearchResult).toHaveBeenCalledOnce());
    const article = screen.getByLabelText("Document: report.pdf").shadowRoot!.querySelector("article")!;
    expect(article.style.color).toBe("rgb(180, 0, 0)");
    expect(article.style.background).toBe("white");
    view.rerender(<NativeDocument bytes={bytes} name="report.pdf" onError={onError} onLocation={() => {}} />);
    expect(native.load).toHaveBeenCalledOnce();
    view.unmount();
    expect(native.destroy).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps the document open when a toolbar operation fails", async () => {
    native.zoomIn.mockRejectedValueOnce(new Error("Zoom is unavailable"));
    const onError = vi.fn();
    render(<NativeDocument bytes={new ArrayBuffer(8)} name="report.pdf" onError={onError} onLocation={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Zoom in document" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Zoom is unavailable");
    expect(screen.getByLabelText("Document: report.pdf")).toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });
});
