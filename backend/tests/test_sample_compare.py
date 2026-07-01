from pathlib import Path

import dataset as datasets
from dataset import build_dataset
from routers.compare import OverlayReq, overlay


ROOT = Path(__file__).resolve().parents[2]
SAMPLES = ROOT / "sample_compare"


def test_real_sample_files_import_and_produce_force_overlay() -> None:
    force_path = (
        SAMPLES / "251_D40Buffer_TM1_200N_1mmpmin_calibration_force.csv"
    )
    capacitance_path = (
        SAMPLES
        / "251_D40Buffer_TM1_200N_1mmpmin_calibration_cap_20260605_145920.csv"
    )
    force = build_dataset(str(force_path), force_path.name)
    capacitance = build_dataset(str(capacitance_path), capacitance_path.name)
    datasets.put(force)
    datasets.put(capacitance)

    assert "Force" in force.arrays
    assert "Force (N)" in capacitance.arrays
    assert force.time[0] == 0
    assert capacitance.time[0] == 0
    assert force.time[-1] > force.time[0]
    assert capacitance.time[-1] > capacitance.time[0]

    result = overlay(
        OverlayReq(
            datasetIds=[force.id, capacitance.id],
            signal="Force",
            offsets={},
        )
    )

    assert result["matchedColumn"] == "Force"
    assert len(result["files"]) == 2
    assert len(result["stats"]) == 1
    assert len(result["time"]) > 1000
