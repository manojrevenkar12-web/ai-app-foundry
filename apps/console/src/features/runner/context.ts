import { createContext, useContext } from "react";
import type { Confirmation, InvokeResult } from "../../lib/api";

/** How blocks run handlers: the live app, or a preview of a bundle that is not published yet. */
export interface RunnerApi {
  /** a key for cached views: the app id and version, or the preview */
  scope: string;
  invoke(handler: string, input: unknown): Promise<InvokeResult>;
  /** asks the person to confirm a write; resolves with the outcome, or null if they cancel */
  askConfirm(c: Confirmation): Promise<unknown | null>;
}

export const RunnerContext = createContext<RunnerApi | null>(null);
export const useRunner = () => {
  const r = useContext(RunnerContext);
  if (!r) throw new Error("blocks must be rendered inside an AppSurface");
  return r;
};
