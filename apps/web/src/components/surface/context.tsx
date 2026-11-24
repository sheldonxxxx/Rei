import type { Surface, SurfaceActionRequest } from "@rei/protocol";
import { createContext, useContext } from "react";

/** What a surface needs from the chat it is in. Without a provider (a preview, a test, the Inspector) surfaces draw read-only. */
export interface SurfaceContextValue {
  /** Posts an action. Resolves once the server accepted it (the user message then arrives on the stream); rejects with the error to show. */
  sendAction?: ((surface: Surface, request: SurfaceActionRequest) => Promise<void>) | undefined;
  /** Whether the chat already holds the input a form's submit made, so the form shows it was sent after a reload too. */
  submitted?: ((surfaceId: string, componentId: string) => boolean) | undefined;
  /** A surface's title, for the "via ..." label on the message its action sent. */
  titleOf?: ((surfaceId: string) => string | undefined) | undefined;
  /** Opens the surface in the Inspector (Full mode only). */
  inspect?: ((surfaceId: string) => void) | undefined;
}

export const SurfaceContext = createContext<SurfaceContextValue>({});
export const useSurfaceContext = () => useContext(SurfaceContext);
