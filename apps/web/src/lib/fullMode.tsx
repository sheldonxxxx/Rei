import { createContext, useContext } from "react";

/** Full mode (inspect every message, run and step; fork from a step) is a global toggle, kept per device. Simple mode is the default. */
export const FULL_MODE_KEY = "rei:full-mode";

export interface FullModeState {
  full: boolean;
  setFull: (next: boolean) => void;
}

export const FullModeContext = createContext<FullModeState>({ full: false, setFull: () => {} });

export const useFullMode = () => useContext(FullModeContext);
