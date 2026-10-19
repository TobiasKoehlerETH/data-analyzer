import { Field, NumberInput } from "@/components/common";
import type { FilterStep } from "@/lib/api";
import { paramDefs } from "@/lib/filters";

/** Parameter fields for one filter step (cutoffs capped at the Nyquist frequency). */
export function FilterParams({ step, onChange, nyquist }: { step: FilterStep; onChange: (s: FilterStep) => void; nyquist: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      {paramDefs(step.filter_type).map((p) => (
        <Field key={p.key} label={p.label} className="[&>label]:w-24">
          <NumberInput
            value={step.params[p.key] ?? p.def}
            min={p.min}
            max={p.freq ? Math.max(p.max, nyquist) : p.max}
            step={p.integer ? 1 : p.freq ? 0.001 : (p.max - p.min) / 100}
            integer={p.integer}
            onChange={(v) => onChange({ ...step, params: { ...step.params, [p.key]: v } })}
          />
        </Field>
      ))}
    </div>
  );
}
