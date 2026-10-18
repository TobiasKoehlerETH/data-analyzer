import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea, .selectable")) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.DEV) {
  // Dev-only handle for driving the UI from browser automation.
  import("./lib/store").then(({ useApp }) => Object.assign(window, { __app: useApp }));
}
