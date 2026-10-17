import { createContext } from "react";

/** Hidden workspaces retain controls and results without redrawing their charts. */
export const WorkspaceActive = createContext(true);
