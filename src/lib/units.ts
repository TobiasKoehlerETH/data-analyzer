/**
 * A small unit catalog: units grouped by quantity, with the factor (and offset, for temperature)
 * to the quantity's base unit, so values can be converted between units of the same quantity.
 * Pure, no imports, so it runs under `node --test`.
 */

export interface UnitDef {
  /** The symbol written on axes, e.g. "kN". */
  symbol: string;
  /** Other spellings found in file headers ("C" for °C, "Nm" for N·m). */
  aliases?: string[];
  /** value_in_base = value × factor + offset */
  factor: number;
  offset?: number;
}

export interface Quantity {
  name: string;
  units: UnitDef[];
  /** Words in a signal name that suggest this quantity. */
  hints: RegExp;
}

const u = (symbol: string, factor: number, aliases: string[] = [], offset = 0): UnitDef => ({ symbol, factor, aliases, offset });

export const QUANTITIES: Quantity[] = [
  { name: "Force", hints: /force|kraft|load|last/i, units: [u("N", 1), u("kN", 1e3), u("mN", 1e-3), u("MN", 1e6), u("lbf", 4.4482216152605), u("kgf", 9.80665)] },
  { name: "Length", hints: /distance|position|displacement|length|stroke|travel|weg|gap|height|depth|width/i, units: [u("m", 1), u("mm", 1e-3), u("µm", 1e-6, ["um", "micron"]), u("cm", 1e-2), u("km", 1e3), u("in", 0.0254, ["inch", '"']), u("ft", 0.3048), u("mil", 2.54e-5)] },
  { name: "Pressure", hints: /pressure|druck|press\b/i, units: [u("bar", 1e5), u("mbar", 100), u("Pa", 1), u("kPa", 1e3), u("MPa", 1e6, ["N/mm²", "N/mm2"]), u("psi", 6894.757293168), u("hPa", 100), u("atm", 101325), u("mmHg", 133.322387415, ["Torr"])] },
  { name: "Temperature", hints: /temp|temperatur/i, units: [u("°C", 1, ["C", "degC", "deg C", "℃", "Celsius"], 273.15), u("K", 1, ["Kelvin"]), u("°F", 5 / 9, ["F", "degF", "deg F", "℉"], 273.15 - (32 * 5) / 9)] },
  { name: "Time", hints: /duration|dauer|delay|period/i, units: [u("s", 1, ["sec"]), u("ms", 1e-3), u("µs", 1e-6, ["us"]), u("min", 60), u("h", 3600, ["hr", "hour"]), u("d", 86400, ["day"])] },
  { name: "Rotational speed", hints: /rpm|speed|drehzahl|tacho|rotation/i, units: [u("rpm", 1 / 60, ["1/min", "U/min", "min⁻¹", "min-1", "r/min"]), u("rev/s", 1, ["rps", "1/s"]), u("rad/s", 1 / (2 * Math.PI)), u("Hz", 1)] },
  { name: "Velocity", hints: /velocity|geschwindigkeit/i, units: [u("m/s", 1), u("mm/s", 1e-3), u("km/h", 1 / 3.6, ["kph"]), u("mph", 0.44704), u("m/min", 1 / 60), u("ft/s", 0.3048)] },
  { name: "Acceleration", hints: /accel|beschleunigung|vibration|vib\b/i, units: [u("m/s²", 1, ["m/s2", "m/s^2"]), u("g", 9.80665, ["G", "gn"]), u("mm/s²", 1e-3, ["mm/s2"])] },
  { name: "Frequency", hints: /freq/i, units: [u("Hz", 1), u("kHz", 1e3), u("MHz", 1e6), u("mHz", 1e-3)] },
  { name: "Torque", hints: /torque|moment|drehmoment/i, units: [u("N·m", 1, ["Nm", "N.m", "N*m", "N m"]), u("kN·m", 1e3, ["kNm"]), u("mN·m", 1e-3, ["mNm"]), u("N·cm", 0.01, ["Ncm"]), u("lbf·ft", 1.3558179483314, ["lbft", "ft·lbf", "ftlb"]), u("lbf·in", 0.1129848290276, ["lbin", "in·lbf"])] },
  { name: "Mass", hints: /mass|weight|gewicht/i, units: [u("kg", 1), u("g", 1e-3, ["gram"]), u("mg", 1e-6), u("t", 1e3), u("lb", 0.45359237, ["lbs"])] },
  { name: "Voltage", hints: /voltage|spannung|volt\b|\bu\d|\bv\d/i, units: [u("V", 1), u("mV", 1e-3), u("µV", 1e-6, ["uV"]), u("kV", 1e3)] },
  { name: "Current", hints: /current|strom|ampere|\bi\d/i, units: [u("A", 1), u("mA", 1e-3), u("µA", 1e-6, ["uA"]), u("kA", 1e3)] },
  { name: "Power", hints: /power|leistung/i, units: [u("W", 1), u("kW", 1e3), u("mW", 1e-3), u("MW", 1e6), u("hp", 745.69987158227)] },
  { name: "Energy", hints: /energy|energie|work\b/i, units: [u("J", 1), u("kJ", 1e3), u("MJ", 1e6), u("Wh", 3600), u("kWh", 3.6e6), u("cal", 4.184)] },
  { name: "Flow", hints: /flow|durchfluss|volumenstrom/i, units: [u("L/min", 1 / 60000, ["l/min", "lpm"]), u("L/s", 1e-3, ["l/s"]), u("L/h", 1 / 3.6e6, ["l/h"]), u("m³/h", 1 / 3600, ["m3/h"]), u("m³/s", 1, ["m3/s"]), u("gal/min", 6.30901964e-5, ["gpm"])] },
  { name: "Angle", hints: /angle|winkel|phase|pitch|roll|yaw/i, units: [u("°", 1, ["deg", "degree", "grad"]), u("rad", 180 / Math.PI), u("mrad", 0.18 / Math.PI), u("rev", 360, ["turn"])] },
  { name: "Ratio", hints: /humidity|feuchte|ratio|duty|efficiency|percent|level\b/i, units: [u("%", 0.01, ["percent", "%RH", "% RH", "rH"]), u("‰", 0.001), u("ppm", 1e-6), u("-", 1, ["1", "ratio"])] },
  { name: "Strain", hints: /strain|dehnung/i, units: [u("µε", 1e-6, ["ue", "microstrain", "µm/m", "um/m"]), u("mm/m", 1e-3), u("ε", 1, ["m/m"])] },
  { name: "Count", hints: /count|counts|pulses|cycles|zähler/i, units: [u("counts", 1, ["cts", "count"])] },
];

const norm = (s: string) => s.trim().replace(/\s+/g, " ");

/** Every quantity a unit belongs to, with its definition ("g" is both a mass and an acceleration). */
export function lookup(unit: string): { quantity: Quantity; unit: UnitDef }[] {
  const s = norm(unit);
  if (!s) return [];
  const out: { quantity: Quantity; unit: UnitDef }[] = [];
  for (const q of QUANTITIES)
    for (const d of q.units) if (d.symbol === s || d.aliases?.includes(s) || (s.length > 2 && d.aliases?.some((a) => a.toLowerCase() === s.toLowerCase()))) out.push({ quantity: q, unit: d });
  return out;
}

/** The catalog's spelling of a unit ("degC" → "°C", "Nm" → "N·m"); unknown units come back trimmed. */
export function canonical(unit: string): string {
  return lookup(unit)[0]?.unit.symbol ?? norm(unit);
}

/** `to = from × scale + offset`, or null when the units are of different (or unknown) quantities. */
export function conversion(from: string, to: string): { scale: number; offset: number; quantity: string } | null {
  if (!norm(from) || !norm(to)) return null;
  for (const a of lookup(from))
    for (const b of lookup(to)) {
      if (a.quantity !== b.quantity) continue;
      // base = v·fa + oa;  to = (base − ob) / fb
      const scale = a.unit.factor / b.unit.factor;
      const offset = ((a.unit.offset ?? 0) - (b.unit.offset ?? 0)) / b.unit.factor;
      return { scale, offset, quantity: a.quantity.name };
    }
  return null;
}

/** Units of the same quantity as `unit` (to convert to), or [] when it is unknown. */
export function related(unit: string): UnitDef[] {
  const q = lookup(unit)[0]?.quantity;
  return q ? q.units : [];
}

/** A likely unit for a signal from words in its name ("Temperature" → °C), or null. */
export function guessUnit(name: string): string | null {
  for (const q of QUANTITIES) if (q.hints.test(name)) return q.units[0].symbol;
  return null;
}

/** "× 0.001", "× 1.8 + 32", "+ 273.15": the conversion as a short formula. */
export function describeConversion(c: { scale: number; offset: number }): string {
  const n = (v: number) => String(Number(v.toPrecision(6)));
  const parts: string[] = [];
  if (Math.abs(c.scale - 1) > 1e-12) parts.push(`× ${n(c.scale)}`);
  if (Math.abs(c.offset) > 1e-12) parts.push(`${c.offset < 0 ? "−" : "+"} ${n(Math.abs(c.offset))}`);
  return parts.join(" ") || "no change";
}

/** A variable name without the unit written in it: "Force (N) · run_a" → "Force · run_a". */
export function bareName(name: string, headerUnit: string): string {
  if (!headerUnit) return name;
  const esc = headerUnit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return name.replace(new RegExp(`\\s*[\\[(]${esc}[\\])]`), "").trim() || name;
}
