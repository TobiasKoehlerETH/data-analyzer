import { test } from "node:test";
import assert from "node:assert/strict";
import { describe, inside, mask, normalize, span, where } from "../src/lib/brush.ts";

test("intervals merge and answer membership", () => {
  const b = normalize([[5, 7], [1, 2], [6, 9], [2, 3]]);
  assert.deepEqual(b, [[1, 3], [5, 9]]);
  assert.ok(inside(2.5, b) && inside(9, b) && !inside(4, b));
  assert.ok(inside(100, []), "no selection selects everything");
  assert.deepEqual(span(b), [1, 9]);
  assert.equal(describe(b), "2 ranges · 6 s");
  assert.equal(describe([[1.25, 2]]), "1.25 – 2 s");
});

test("masking keeps rows and blanks the rest", () => {
  assert.deepEqual(mask([0, 1, 2, 3], [10, 11, 12, 13], [[1, 2]]), [null, 11, 12, null]);
});

test("where a signal is in a range", () => {
  const t = [0, 1, 2, 3, 4, 5, 6, 7];
  const v = [0, 5, 6, 0, 7, null, 8, 0];
  assert.deepEqual(where(t, v, 4, null), [[1, 2], [4, 4], [6, 6]]);
  assert.deepEqual(where(t, v, 4, 6.5), [[1, 2]]);
  assert.deepEqual(where(t, v, 4, null, 2), [[1, 6]], "runs 2 s apart are joined");
});

test("axes map between chart x and time", async () => {
  const { rowAxis, dateAxis } = await import("../src/lib/brush.ts");
  const r = rowAxis([0, 0.5, 1, 1.5]);
  assert.equal(r.toTime(3), 1);
  assert.equal(r.toX(1), 3);
  assert.equal(r.toX(0.75), 2.5);
  const d = dateAxis(1000);
  assert.equal(d.toX(2), 1002000);
  assert.equal(d.toTime(1002000), 2);
});
