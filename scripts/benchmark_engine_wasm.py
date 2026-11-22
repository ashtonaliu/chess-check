"""Time batch operations in Node and Chrome, then compare extension ZIP sizes."""

import argparse
import base64
import html
import json
import os
from pathlib import Path
import re
import statistics
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def sizes(before, after):
    with zipfile.ZipFile(after) as package:
        entry = package.getinfo("engine/engine_core_bg.wasm")
    return {"wasm_bytes": entry.file_size, "wasm_deflated_bytes": entry.compress_size,
            "before_zip_bytes": before.stat().st_size, "after_zip_bytes": after.stat().st_size,
            "zip_growth_bytes": after.stat().st_size - before.stat().st_size}


def sample(path):
    fixture = json.loads((ROOT / "engine-core/tests/fixtures/find_rate_features.json").read_text())
    rows = fixture["positions"]
    positions = [{"fen": fen, "move": uci} for fen, uci, *_ in
                 (rows[i * len(rows) // 512] for i in range(512))]
    reference = json.loads((ROOT / "web/test/fixtures/archive_187138001290.json").read_text())
    games = [g for g in json.loads(path.read_text())["games"] if
             g.get("pgn") and g["rules"] == "chess" and g["time_class"] == "bullet"
             and g["end_time"] < reference["end_time"]]
    pgns = [g["pgn"] for g in sorted(games, key=lambda g: g["end_time"], reverse=True)[:24]]
    if len(pgns) != 24:
        raise ValueError("The benchmark needs 24 PGNs from the profile archive")
    return positions, pgns


def benchmark(args):
    positions, pgns = sample(args.archive)
    engine = ROOT / "extension/engine"
    encoded = base64.b64encode((engine / "engine_core_bg.wasm").read_bytes()).decode("ascii")
    versions = {name: subprocess.check_output([exe, "--version"], text=True).strip()
                for name, exe in (("node", "node"), ("chrome", args.chrome))}
    samples = {name: {} for name in versions}
    checksums = {}
    with tempfile.TemporaryDirectory(prefix="engine-wasm-timing-") as folder:
        out = Path(folder)
        script, page = out / "benchmark.js", out / "benchmark.html"
        entry = f"""
import * as bindings from {json.dumps(str(engine / 'engine_core.js'))};
import {{ time }} from {json.dumps(str(ROOT / 'web/scripts/timeEngineWasm.ts'))};
bindings.initSync({{module: Uint8Array.from(atob({json.dumps(encoded)}), char => char.charCodeAt(0))}});
const result = JSON.stringify(time(bindings, {json.dumps(positions)}, {json.dumps(pgns)}, 5));
if (typeof document === 'undefined') console.log(result);
else document.getElementById('result').textContent = result;
"""
        subprocess.run([ROOT / "web/node_modules/.bin/esbuild", "--bundle", "--minify",
                        "--format=iife", "--log-override:empty-import-meta=silent", f"--outfile={script}"],
                       cwd=ROOT, input=entry, text=True, check=True)
        page.write_text('<!doctype html><meta charset="utf-8"><pre id="result"></pre><script src="benchmark.js"></script>')
        for i in range(3):
            node = json.loads(subprocess.check_output(["node", script], text=True, timeout=180))
            chrome = subprocess.run([args.chrome, "--headless=new", "--no-first-run", "--disable-background-networking",
                                     "--disable-extensions", f"--user-data-dir={out / f'chrome-{i}'}",
                                     "--dump-dom", page.as_uri()], text=True, capture_output=True, check=True, timeout=180)
            result = re.search(r'<pre id="result">(.*?)</pre>', chrome.stdout, re.S)
            if not result or not result[1]:
                raise RuntimeError(f"Chrome did not return timings: {chrome.stderr}")
            for name, timings in (("node", node), ("chrome", json.loads(html.unescape(result[1])))):
                for op, record in timings.items():
                    if record["checksum"] != checksums.setdefault(op, record["checksum"]):
                        raise ValueError(f"Result changed across launches for {op}")
                    aggregate = samples[name].setdefault(op, {"js": [], "wasm": []})
                    for path in aggregate:
                        aggregate[path].extend(record[path])
    return {
        "versions": versions, "positions": len(positions), "games": len(pgns), "launches": 3, "passes": 5,
        "microseconds_per_unit": {
            runtime: {op: {path: statistics.median(values) for path, values in modes.items()}
                      for op, modes in measurements.items()}
            for runtime, measurements in samples.items()
        },
        "sizes": sizes(args.before_zip, args.after_zip),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", type=Path)
    parser.add_argument("before_zip", type=Path)
    parser.add_argument("after_zip", type=Path)
    parser.add_argument("--chrome", default=os.environ.get(
        "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
    print(json.dumps(benchmark(parser.parse_args()), indent=2))
