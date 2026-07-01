"""Quick end-to-end check of the dataset layer against sample_data.csv.

Run: backend/.venv/Scripts/python backend/smoke_test.py
"""

import numpy as np

import dataset as ds

d = ds.build_dataset("../sample_data.csv", "sample_data.csv")
print("id:", d.id, "| raser:", d.raser, "| rows:", d.time.size, "| signals:", len(d.order))
print("info:", d.info)
print("signals:", d.order)
print("sample_rate:", round(d.sample_rate, 3), "Hz | duration:", round(d.duration, 1), "s")
print("first stat:", ds.signal_stats(d)[0])

# Verify binary layout: [time, ...signals] reconstructs correctly.
names = d.order[:2]
cols = [d.time, *(d.arrays[n] for n in names)]
buf = np.concatenate(cols).astype(np.float32)
n = d.time.size
assert buf.size == n * (len(names) + 1)
assert np.allclose(buf[:n], d.time)
assert np.allclose(buf[n : 2 * n], d.arrays[names[0]], equal_nan=True)
print("binary layout OK; preview rows:", len(d.preview["rows"]))
print("PASS")
