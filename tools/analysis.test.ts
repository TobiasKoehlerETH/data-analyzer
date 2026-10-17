import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chartFitSources,
  finitePairs,
  histogram,
  summarize,
  matchingRows,
} from "../src/lib/analysis.ts";

test("missing observations keep their original row positions", () => {
  assert.deepEqual(finitePairs([1, 2, 3, 4], [10, null, 30, NaN]), [
    [1, 10],
    [3, 30],
  ]);
  assert.deepEqual(summarize([1, null, 2, 3, 4, NaN]), {
    count: 4,
    missing: 2,
    mean: 2.5,
    std: Math.sqrt(5 / 3),
    min: 1,
    q1: 1.75,
    median: 2.5,
    q3: 3.25,
    max: 4,
    iqr: 1.5,
  });
});
test("histogram counts every finite observation, including right boundary and constant data", () => {
  assert.deepEqual(histogram([2, 2, null, 2]), [[2, 3]]);
  const bins = histogram([0, 1, 2, 3, 4, null], 2);
  assert.deepEqual(bins, [
    [1, 2],
    [3, 3],
  ]);
  assert.deepEqual(histogram([], 2, [0, 4]), [
    [1, 0],
    [3, 0],
  ]);
});
test("linked selection matches unsorted full vectors, not rendered sample indices", () => {
  const x = [9, 1, 8, 2, null, 3],
    y = [90, 10, 80, 20, 40, null];
  assert.deepEqual(
    [...matchingRows(x, y, { kind: "scatter", x: [1, 8], y: [15, 85] })],
    [2, 3],
  );
  assert.deepEqual(
    [...matchingRows(x, y, { kind: "row", x: [2, 5] })],
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    [...matchingRows(x, y, { kind: "histogram", x: [20, 80] })],
    [2, 3, 4],
  );
  assert.equal(matchingRows(x, y, { kind: "scatter", x: [100, 200] }).size, 0);
});
test("fitting accepts numeric XY charts and excludes matrices, categories and fit overlays", () => {
  const sources = chartFitSources({
    xAxis: [{ type: "value", name: "Force" }, { type: "category" }],
    yAxis: { type: "value" },
    series: [
      {
        type: "scatter",
        name: "Displacement",
        data: [
          [3, 4],
          [1, 2],
          [2, 3],
          [null, 5],
        ],
      },
      {
        type: "heatmap",
        data: [
          [0, 0, 1],
          [1, 1, 2],
          [2, 2, 3],
        ],
      },
      {
        type: "bar",
        xAxisIndex: 1,
        data: [
          [1, 2],
          [2, 3],
          [3, 4],
        ],
      },
      {
        id: "curve-fit-overlay",
        type: "line",
        data: [
          [1, 2],
          [2, 3],
          [3, 4],
        ],
      },
      {
        type: "line",
        name: "Spectrum",
        data: [{ value: [1, 2] }, [2, 3], [3, 4]],
      },
    ],
  });
  assert.equal(sources.length, 2);
  assert.equal(sources[0].xLabel, "Force");
  assert.deepEqual(sources[0].points, [
    [3, 4],
    [1, 2],
    [2, 3],
  ]);
  assert.equal(sources[1].seriesIndex, 4);
});
