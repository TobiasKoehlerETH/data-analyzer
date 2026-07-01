/** Categorical palette for plot traces (works on light and dark backgrounds). */
export const palette = [
  "#2563eb", "#dc2626", "#16a34a", "#d97706", "#9333ea",
  "#0891b2", "#db2777", "#65a30d", "#e11d48", "#7c3aed",
]

export const colorFor = (i: number) => palette[i % palette.length]
