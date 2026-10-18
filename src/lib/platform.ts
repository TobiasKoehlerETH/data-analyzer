/**
 * Platform layer: Tauri APIs inside the desktop app, with a development fallback that talks
 * to the app's local dev bridge (http://127.0.0.1:1430) so the UI can run in a normal browser.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import * as dialog from "@tauri-apps/plugin-dialog";
import * as opener from "@tauri-apps/plugin-opener";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const BRIDGE = "http://127.0.0.1:1430";

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isTauri) return tauriInvoke<T>(cmd, args);
  const res = await fetch(`${BRIDGE}/invoke/${cmd}`, { method: "POST", body: JSON.stringify(args ?? {}) });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || body.error !== undefined) throw body.error ?? `HTTP ${res.status}`;
  return body.result as T;
}

type Handler<T> = (e: { payload: T }) => void;
const browserListeners = new Map<string, Set<Handler<unknown>>>();
let poller: ReturnType<typeof setInterval> | undefined;

function ensurePoller() {
  if (poller) return;
  poller = setInterval(async () => {
    try {
      const res = await fetch(`${BRIDGE}/events`);
      const events = (await res.json()) as { event: string; payload: unknown }[];
      for (const e of events) browserListeners.get(e.event)?.forEach((h) => h({ payload: e.payload }));
    } catch {
      /* bridge not running */
    }
  }, 250);
}

export async function listen<T>(event: string, handler: Handler<T>): Promise<UnlistenFn> {
  if (isTauri) return tauriListen<T>(event, handler);
  const set = browserListeners.get(event) ?? new Set();
  set.add(handler as Handler<unknown>);
  browserListeners.set(event, set);
  ensurePoller();
  return () => set.delete(handler as Handler<unknown>);
}

type OpenOptions = dialog.OpenDialogOptions;

/** File picker; in the browser a path prompt (several paths separated by ';'). */
export async function open(options: OpenOptions = {}): Promise<string | string[] | null> {
  if (isTauri) return dialog.open(options);
  const v = window.prompt(`${options.title ?? "Open file"} — enter a full path${options.multiple ? " (separate several with ;)" : ""}`, "");
  if (!v) return null;
  const parts = v.split(";").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  return options.multiple ? parts : parts[0];
}

export async function save(options: dialog.SaveDialogOptions = {}): Promise<string | null> {
  if (isTauri) return dialog.save(options);
  return window.prompt(`${options.title ?? "Save as"} — enter a full path`, options.defaultPath ?? "") || null;
}

export async function message(text: string, options?: dialog.MessageDialogOptions | string): Promise<void> {
  if (isTauri) {
    await dialog.message(text, options);
    return;
  }
  window.alert(text);
}

export async function ask(text: string, options?: dialog.ConfirmDialogOptions | string): Promise<boolean> {
  if (isTauri) return dialog.ask(text, options);
  return window.confirm(text);
}

export async function openPath(path: string): Promise<void> {
  if (isTauri) return opener.openPath(path);
  window.alert(`Open in the desktop app: ${path}`);
}
