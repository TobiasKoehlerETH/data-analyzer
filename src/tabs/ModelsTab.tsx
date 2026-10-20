import { useEffect, useState } from "react";
import { open, save, ask, message } from "@/lib/platform";
import { Copy, FolderOpen, GitCompare, Pencil, Save, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState, Panel } from "@/components/common";
import { api, errorText, JSON_FILTERS, type StateSpaceModel } from "@/lib/api";
import { fmtG } from "@/lib/chart";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

type MatKey = "A" | "B" | "C" | "D";

function MatrixEditor({ label, value, onChange }: { label: string; value: string[][]; onChange: (v: string[][]) => void }) {
  const rows = value.length;
  const cols = value[0]?.length ?? 0;
  return (
    <div className="mb-3">
      <p className="mb-1 text-[13px] text-ap-red">
        Matrix {label} ({rows}×{cols})
      </p>
      {rows === 0 || cols === 0 ? (
        <p className="text-xs text-muted-foreground">empty</p>
      ) : (
        <div className="overflow-auto">
          <table className="border-collapse text-[11.5px]">
            <tbody>
              {value.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className="border border-ap-line p-0">
                      <input
                        className="w-24 px-1.5 py-0.5 text-right tabular-nums outline-none focus:bg-ap-bluegray-15"
                        value={cell}
                        onChange={(e) => onChange(value.map((rr, i) => (i === r ? rr.map((x, j) => (j === c ? e.target.value : x)) : rr)))}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function ModelsTab() {
  const { models, refreshModels, showStatus } = useApp();
  const [selected, setSelected] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [compareRows, setCompareRows] = useState<[string, string][][] | null>(null);
  const [detail, setDetail] = useState<StateSpaceModel | null>(null);
  const [mats, setMats] = useState<Record<MatKey, string[][]>>({ A: [], B: [], C: [], D: [] });
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    setSelected((s) => s.filter((n) => models.some((m) => m.name === n)));
    if (detail && !models.some((m) => m.name === detail.name)) setDetail(null);
  }, [models, detail]);

  const clickRow = (e: React.MouseEvent, i: number, name: string) => {
    if (e.shiftKey && anchor !== null) {
      const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
      setSelected(models.slice(a, b + 1).map((m) => m.name));
    } else if (e.ctrlKey) {
      setSelected(selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name]);
      setAnchor(i);
    } else {
      setSelected([name]);
      setAnchor(i);
    }
  };

  const openDetail = async (name: string) => {
    const m = await api.modelDetail(name);
    setDetail(m);
    setCompareRows(null);
    setMats({
      A: m.A.map((r) => r.map(fmtG)),
      B: m.B.map((r) => r.map(fmtG)),
      C: m.C.map((r) => r.map(fmtG)),
      D: m.D.map((r) => r.map(fmtG)),
    });
  };

  const saveMatrices = async () => {
    if (!detail) return;
    const parse = (m: string[][]) => m.map((r) => r.map((c) => (Number.isFinite(Number(c)) ? Number(c) : 0)));
    try {
      await api.modelUpdateMatrices(detail.name, parse(mats.A), parse(mats.B), parse(mats.C), parse(mats.D));
      await refreshModels();
      await message(`Matrices for '${detail.name}' updated.`, { title: "Saved" });
    } catch (e) {
      await message(errorText(e), { title: "Save Failed", kind: "error" });
    }
  };

  const del = async () => {
    if (!selected.length) return;
    if (!(await ask(`Delete ${selected.length} model(s)?`, { title: "Delete Models", kind: "warning" }))) return;
    await api.modelDelete(selected);
    setSelected([]);
    await refreshModels();
  };

  const compare = async () => {
    if (selected.length < 2) {
      await message("Select at least 2 models to compare.", { title: "Compare" });
      return;
    }
    setCompareRows(await api.modelsCompare(selected));
    setDetail(null);
  };

  const compareKeys = compareRows ? [...new Set(compareRows.flatMap((r) => r.map(([k]) => k)))] : [];

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={!selected.length} onClick={async () => { await api.modelDuplicate(selected); await refreshModels(); }} title="Create a copy of the selected model(s)">
          <Copy /> Duplicate
        </Button>
        <Button size="sm" variant="outline" onClick={async () => {
          if (selected.length !== 1) return message("Select exactly one model to rename.", { title: "Rename" });
          setNewName(selected[0]);
          setRenameOpen(true);
        }} title="Rename the selected model">
          <Pencil /> Rename
        </Button>
        <Button size="sm" variant="outline" disabled={!selected.length} onClick={del} title="Delete the selected model(s) from the library">
          <Trash2 /> Delete
        </Button>
        <Button size="sm" variant="outline" onClick={compare} title="Compare metrics of two or more selected models side by side">
          <GitCompare /> Compare Selected
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={async () => {
          const p = await save({ filters: JSON_FILTERS, defaultPath: "models.json", title: "Save Model Library" });
          if (!p) return;
          await api.modelsSave(p).then(() => showStatus(`Models saved to ${p}`)).catch((e) => message(errorText(e), { kind: "error" }));
        }} title="Save all models to a JSON file">
          <Save /> Save Library
        </Button>
        <Button size="sm" variant="outline" onClick={async () => {
          const p = await open({ filters: JSON_FILTERS, title: "Load Model Library" });
          if (typeof p !== "string") return;
          try {
            await api.modelsLoad(p);
            await refreshModels();
            showStatus(`Models loaded from ${p}`);
          } catch (e) {
            await message(errorText(e), { kind: "error" });
          }
        }} title="Load models from a previously saved JSON file">
          <FolderOpen /> Load Library
        </Button>
      </div>

      <ResizablePanelGroup orientation="vertical" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="45%" minSize="20%">
          <Panel title={`Model library · ${models.length}`} className="h-full" bodyClassName="p-0 overflow-auto">
            <Table className="text-[12.5px]">
              <TableHeader className="sticky top-0 bg-white">
                <TableRow>
                  {["Name", "Method", "Order", "Inputs", "Outputs", "Decimation", "Mean VAF%", "Timestamp"].map((h) => (
                    <TableHead key={h} className="text-black">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map((m, i) => (
                  <TableRow
                    key={m.name}
                    onClick={(e) => clickRow(e, i, m.name)}
                    onDoubleClick={() => openDetail(m.name)}
                    className={cn("cursor-default", selected.includes(m.name) && "bg-ap-bluegray-15 hover:bg-ap-bluegray-15")}
                    title="Double-click to view and edit the state-space matrices"
                  >
                    <TableCell className={cn("py-1", selected.includes(m.name) && "text-ap-red")}>{m.name}</TableCell>
                    <TableCell className="py-1">{m.method}</TableCell>
                    <TableCell className="py-1 tabular-nums">{m.order}</TableCell>
                    <TableCell className="py-1 tabular-nums">{m.n_inputs}</TableCell>
                    <TableCell className="py-1 tabular-nums">{m.n_outputs}</TableCell>
                    <TableCell className="py-1 tabular-nums">{m.decimation_factor}</TableCell>
                    <TableCell className="py-1 tabular-nums">{m.mean_vaf.toFixed(2)}</TableCell>
                    <TableCell className="py-1 tabular-nums">{m.timestamp.slice(0, 19)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {models.length === 0 && <EmptyState title="No models yet" />}
          </Panel>
        </ResizablePanel>
        <ResizableHandle className="my-1 bg-transparent" />
        <ResizablePanel defaultSize="55%" minSize="20%">
          <Panel
            title={compareRows ? "Model comparison" : "Model details"}
            className="h-full"
            bodyClassName="overflow-auto selectable"
            actions={
              detail && (
                <Button size="sm" onClick={saveMatrices} title="Save edited matrix values back to the model">
                  <Save /> Save Changes
                </Button>
              )
            }
          >
            {compareRows ? (
              <Table className="text-[12px]">
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-black">Metric</TableHead>
                    {compareRows.map((r, i) => (
                      <TableHead key={i} className="text-ap-red">
                        {r.find(([k]) => k === "Name")?.[1]}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {compareKeys
                    .filter((k) => k !== "Name")
                    .map((k) => (
                      <TableRow key={k}>
                        <TableCell className="py-1 text-muted-foreground">{k}</TableCell>
                        {compareRows.map((r, i) => (
                          <TableCell key={i} className="py-1 tabular-nums">
                            {r.find(([kk]) => kk === k)?.[1] ?? "—"}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            ) : detail ? (
              <div>
                <div className="ap-box mb-3 space-y-1 p-3 text-[12.5px]">
                  <p>
                    <b>Name:</b> {detail.name} &nbsp; <b>Method:</b> {detail.method} &nbsp; <b>Order:</b> {detail.order} &nbsp; <b>dt:</b> {detail.dt.toFixed(4)}s &nbsp;{" "}
                    <b>Decimation:</b> {detail.decimation_factor}
                  </p>
                  <p>
                    <b>Inputs:</b> {detail.input_names.join(", ")}
                  </p>
                  <p>
                    <b>Outputs:</b> {detail.output_names.join(", ")}
                  </p>
                  {detail.metrics.length > 0 && (
                    <p>
                      <b>Metrics:</b> {detail.metrics.map((m) => `${m.name}: VAF=${m.vaf.toFixed(2)}%`).join(" | ")}
                    </p>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-x-6 xl:grid-cols-2">
                  {(["A", "B", "C", "D"] as MatKey[]).map((k) => (
                    <MatrixEditor key={k} label={k} value={mats[k]} onChange={(v) => setMats({ ...mats, [k]: v })} />
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">Double-click a model to open it.</p>
            )}
          </Panel>
        </ResizablePanel>
      </ResizablePanelGroup>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-normal text-ap-red">Rename model</DialogTitle>
          </DialogHeader>
          <Input value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                try {
                  await api.modelRename(selected[0], newName);
                  setSelected([newName.trim()]);
                  setRenameOpen(false);
                  await refreshModels();
                } catch (e) {
                  await message(errorText(e), { title: "Rename Failed", kind: "warning" });
                }
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
