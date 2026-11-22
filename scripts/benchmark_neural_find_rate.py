"""Time the exported TypeScript predictor in Node and isolated headless Chrome."""
import argparse
import html
import json
from pathlib import Path
import re
import subprocess
import tempfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]


def run(export, chrome, trials, count, passes):
    artifact = json.loads((export / "weights.json").read_text())
    sample = json.loads((export / "parity.json").read_text())[-count:]
    if len(sample) != count or any(row["context"]["source"] != "chesscom" for row in sample):
        raise ValueError("The trained parity fixture must end with the sampled Chess.com positions")
    positions = [{key: row[key] for key in ("fen", "best", "context")} for row in sample]
    versions = {runtime: subprocess.check_output([executable, "--version"], text=True).strip()
                for runtime, executable in (("node", "node"), ("chrome", chrome))}
    durations = {name: {"forward": [], "withEncoding": []} for name in versions}
    with tempfile.TemporaryDirectory(prefix="find-rate-benchmark-") as path:
        folder = Path(path)
        bundle = folder / "benchmark.js"
        subprocess.run([str(ROOT / "web/node_modules/.bin/esbuild"), str(ROOT / "web/scripts/timeNeuralFindRate.ts"),
                        "--bundle", "--minify", "--format=iife", "--global-name=benchmark", f"--outfile={bundle}"],
                       check=True)
        with bundle.open("a") as handle:
            handle.write("\nconst result = JSON.stringify(benchmark.time(")
            handle.write(",".join(json.dumps(value, separators=(",", ":")) for value in (artifact, positions, passes)))
            handle.write("));\nif (typeof document === 'undefined') console.log(result);\n"
                         "else document.getElementById('result').textContent = result;\n")
        page = folder / "benchmark.html"
        page.write_text('<!doctype html><meta charset="utf-8"><pre id="result"></pre><script src="benchmark.js"></script>')
        for trial in range(trials):
            node = json.loads(subprocess.check_output(["node", str(bundle)], text=True, timeout=120))
            profile = folder / f"chrome-{trial}"
            chrome_result = subprocess.run([
                chrome, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-extensions",
                "--disable-background-networking", f"--user-data-dir={profile}", "--dump-dom", page.as_uri(),
            ], capture_output=True, text=True, timeout=120, check=True)
            match = re.search(r'<pre id="result">(.*?)</pre>', chrome_result.stdout, re.S)
            if not match or not match[1]:
                raise RuntimeError(f"Chrome did not return benchmark data: {chrome_result.stderr}")
            browser = json.loads(html.unescape(match[1]))
            for mode in durations["node"]:
                np.testing.assert_allclose(
                    [node[mode]["checksum"], browser[mode]["checksum"]], node["forward"]["checksum"], rtol=0, atol=1e-6)
                for name, result in (("node", node), ("chrome", browser)):
                    measured = result[mode]["ms"]
                    if len(measured) != count * passes:
                        raise ValueError(f"{name} returned an unexpected number of measurements")
                    durations[name][mode].extend(measured)

    return {
        "versions": versions, "launches": trials, "warmup_per_launch": count, "positions_per_launch": count * passes,
        "scores": {name: {mode: dict(zip(("median_ms", "p95_ms"), np.percentile(ms, [50, 95]).tolist()))
                          for mode, ms in measurements.items()} for name, measurements in durations.items()},
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--chrome", default="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    parser.add_argument("--trials", type=int, default=3)
    parser.add_argument("--count", type=int, default=300)
    parser.add_argument("--passes", type=int, default=3)
    args = parser.parse_args()
    result = run(args.export, args.chrome, args.trials, args.count, args.passes)
    report = json.dumps(result, indent=2) + "\n"
    (args.export / "timings.json").write_text(report)
    print(report, end="")
