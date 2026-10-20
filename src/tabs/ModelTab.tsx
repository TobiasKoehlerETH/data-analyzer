import { useContext, useEffect, useState } from "react";
import { BadgeCheck, Cpu, Library, Play } from "lucide-react";
import { EmptyState, Segmented } from "@/components/common";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { WorkspaceActive } from "@/lib/workspace";
import { SysIdTab } from "./SysIdTab";
import { ModelsTab } from "./ModelsTab";
import { SimulationTab } from "./SimulationTab";
import { ValidationTab } from "./ValidationTab";

type Sub = "identify" | "library" | "simulate" | "validate";

const SUBS: { id: Sub; label: string; icon: typeof Cpu; component: () => React.ReactElement; needsData: boolean; hint: string }[] = [
  { id: "identify", label: "Identify", icon: Cpu, component: SysIdTab, needsData: true, hint: "Choose inputs and outputs, then identify a state-space model." },
  { id: "library", label: "Library", icon: Library, component: ModelsTab, needsData: false, hint: "Saved models. Double-click a model to inspect or edit it." },
  { id: "simulate", label: "Simulate", icon: Play, component: SimulationTab, needsData: true, hint: "Run a saved model on the measured inputs and compare outputs." },
  { id: "validate", label: "Validate", icon: BadgeCheck, component: ValidationTab, needsData: true, hint: "Check a model's residuals and fit quality." },
];

/** State-space modelling: identify, store, simulate and validate, one tab each. */
export function ModelTab() {
  const active = useContext(WorkspaceActive);
  const { dataset, models } = useApp();
  const [tab, setTab] = useState<Sub>("identify");
  const [visited, setVisited] = useState(() => new Set<Sub>([tab]));

  useEffect(() => setVisited((v) => (v.has(tab) ? v : new Set(v).add(tab))), [tab]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex shrink-0 items-center">
        <Segmented
          value={tab}
          onChange={setTab}
          options={SUBS.map((s) => ({ value: s.id, label: s.id === "library" && models.length > 0 ? `${s.label} · ${models.length}` : s.label, hint: s.hint }))}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {SUBS.map((s) => {
          if (!visited.has(s.id)) return null;
          const C = s.component;
          return (
            <div key={s.id} role="tabpanel" className={cn("absolute inset-0 overflow-hidden", s.id !== tab && "invisible")}>
              <WorkspaceActive.Provider value={active && s.id === tab}>
                {s.needsData && !dataset ? <EmptyState title="No data loaded" /> : <C />}
              </WorkspaceActive.Provider>
            </div>
          );
        })}
      </div>
    </div>
  );
}
