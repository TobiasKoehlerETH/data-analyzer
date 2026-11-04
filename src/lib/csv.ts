import { toast } from "sonner";
import { api, errorText } from "./api";
import { save } from "./platform";
import { toCsv } from "./peaks";

/** Asks where to save, then writes the table as CSV. Returns the path, or null when cancelled. */
export async function saveCsv(defaultName: string, header: string[], rows: (string | number | null | undefined)[][]): Promise<string | null> {
  const picked = await save({ filters: [{ name: "CSV", extensions: ["csv"] }], title: "Export as CSV", defaultPath: defaultName });
  if (!picked) return null;
  const path = /\.csv$/i.test(picked) ? picked : `${picked}.csv`;
  try {
    await api.saveText(path, toCsv(header, rows));
    toast.success(`${rows.length.toLocaleString("en-US")} rows saved to ${path}`);
    return path;
  } catch (e) {
    toast.error(errorText(e));
    return null;
  }
}

/** A file-name-safe stem: "Force [N] · run_a" → "Force-N-run_a". */
export const fileStem = (s: string) => s.replace(/[^\p{L}\p{N}_.-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "export";
