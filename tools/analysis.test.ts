import { test } from "node:test";
import assert from "node:assert/strict";
import {
  finitePairs,
  histogram,
  summarize,
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
