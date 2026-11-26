"""Compute per-site, per-speed median review clock fractions over non-test rows."""
import argparse
import json
from pathlib import Path
import sys

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from scripts.eval_find_rate import TEST_MOD

PAIRS = (
    ("chesscom", ("bullet", "blitz", "rapid")),
    ("lichess", ("ultraBullet", "bullet", "blitz", "rapid", "classical")),
)


def compute_medians(rows_path: Path) -> tuple[dict[str, dict[str, float]], list[dict]]:
    df = pd.read_parquet(rows_path, columns=["player", "source", "time_class", "clock_frac", "split"])
    groups = pd.util.hash_pandas_object(df["player"].str.casefold(), index=False).to_numpy()
    non_test = df.loc[(df["split"] != "test") & (groups % TEST_MOD != 0)]
    if not len(non_test):
        raise ValueError(f"No non-test rows found in {rows_path}")

    clocks: dict[str, dict[str, float]] = {}
    summary: list[dict] = []
    for site, speeds in PAIRS:
        clocks[site] = {}
        for speed in speeds:
            sub = non_test.loc[(non_test["source"] == site) & (non_test["time_class"] == speed)]
            valid = sub["clock_frac"].dropna()
            if not len(valid):
                raise ValueError(f"No non-missing non-test clock_frac rows for {site} {speed}")
            median = round(float(valid.median()), 4)
            clocks[site][speed] = median
            summary.append({
                "site": site,
                "speed": speed,
                "non_test_rows": int(len(sub)),
                "non_missing_clocks": int(len(valid)),
                "median": median,
            })
    return clocks, summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--prepared",
        type=Path,
        default=ROOT / "eval_results" / "neural-find-rate" / "prepared-v2",
        help="Prepared directory containing rows.parquet",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=ROOT / "eval_results" / "review-calibration-per-speed" / "review_clocks.json",
        help="Destination JSON file for per-site, per-speed review clock fractions",
    )
    args = parser.parse_args()

    rows_path = args.prepared / "rows.parquet" if args.prepared.is_dir() else args.prepared
    clocks, summary = compute_medians(rows_path)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(clocks, indent=2) + "\n")

    print(f"Wrote {args.output} from {rows_path}")
    print(f"{'Site':10} {'Speed':12} {'Non-test n':12} {'With clock':12} {'Median':8}")
    for row in summary:
        print(
            f"{row['site']:10} {row['speed']:12} {row['non_test_rows']:12,d} "
            f"{row['non_missing_clocks']:12,d} {row['median']:8.4f}"
        )


if __name__ == "__main__":
    main()
