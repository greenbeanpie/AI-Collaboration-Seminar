"""Independently audit the resource sampler CSVs with Python's standard library."""
from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
from collections import defaultdict
from pathlib import Path


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def key(row: dict) -> tuple[str, str, int]:
    return row["label"], row["scenario"], int(row["trial"])


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def same(actual, expected, label: str) -> None:
    require(actual is None and expected is None or actual is not None and expected is not None
            and math.isclose(actual, expected, abs_tol=1e-8, rel_tol=1e-10), f"{label}: {actual} != {expected}")


def audit(folder: Path) -> dict:
    samples = read_csv(folder / "raw-samples.csv")
    processes = read_csv(folder / "process-samples.csv")
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8-sig"))
    reported_trials = {key(row): row for row in json.loads((folder / "trials.json").read_text(encoding="utf-8-sig"))}
    reported_summary = {(row["label"], row["scenario"]): row for row in json.loads((folder / "summary.json").read_text(encoding="utf-8-sig"))}
    trial_rows = defaultdict(list)
    process_rows = defaultdict(list)
    for row in samples:
        trial_rows[key(row)].append(row)
    for row in processes:
        process_rows[key(row)].append(row)
    require(set(trial_rows) == set(reported_trials), "CSV and trial JSON keys differ")
    require(set(trial_rows) == set(process_rows), "Missing process tree samples")
    recomputed = []
    for trial_key, rows in sorted(trial_rows.items()):
        rows.sort(key=lambda row: int(row["sample"]))
        require([int(row["sample"]) for row in rows] == list(range(len(rows))), f"Non-contiguous or duplicate sample IDs: {trial_key}")
        elapsed = [float(row["elapsedSeconds"]) for row in rows]
        require(all(right > left for left, right in zip(elapsed, elapsed[1:])), f"Non-monotonic elapsed time: {trial_key}")
        identities = {}
        records = {}
        roots = set()
        root_name = "buwei.windows.native.exe" if trial_key[0] == "winui-native" else "buwei-desktop.exe"
        per_sample = defaultdict(list)
        for row in process_rows[trial_key]:
            pid = int(row["processId"])
            identity = row["creationUtc"]
            require(pid not in identities or identities[pid] == identity, f"PID reuse requires a richer attribution audit: {trial_key}/{pid}")
            identities[pid] = identity
            records[pid] = row
            per_sample[int(row["sample"])].append(row)
            if row["name"].lower() == root_name:
                roots.add(pid)
        require(len(roots) == 1, f"Expected exactly one root process: {trial_key}")
        for pid in records:
            chain = set()
            current = pid
            while current not in roots:
                require(current not in chain and current in records, f"Missing parent or cyclic attribution: {trial_key}/{pid}")
                chain.add(current)
                current = int(records[current]["parentProcessId"])
        for row in rows:
            members = per_sample[int(row["sample"])]
            require(len(members) == int(row["processCount"]), f"Process count mismatch: {trial_key}/{row['sample']}")
            require(sum(int(member["privateBytes"]) for member in members) == int(row["privateBytes"]), f"Private byte total mismatch: {trial_key}/{row['sample']}")
            require(sum(int(member["workingSetBytes"]) for member in members) == int(row["workingSetBytes"]), f"Working set total mismatch: {trial_key}/{row['sample']}")
        cpu = [float(row["cpuPercentMachine"]) for row in rows if row["cpuPercentMachine"]]
        calculated = dict(label=trial_key[0], scenario=trial_key[1], trial=trial_key[2], samples=len(rows),
                          medianPrivateMiB=statistics.median(int(row["privateBytes"]) / 1048576 for row in rows),
                          peakPrivateMiB=max(int(row["privateBytes"]) / 1048576 for row in rows),
                          medianWorkingSetMiB=statistics.median(int(row["workingSetBytes"]) / 1048576 for row in rows),
                          medianCpuPercentMachine=statistics.median(cpu) if cpu else None,
                          meanCpuPercentMachine=statistics.mean(cpu) if cpu else None,
                          firstSampleSeconds=elapsed[0], lastSampleSeconds=elapsed[-1], validCpuSamples=len(cpu),
                          processNames=sorted({row["name"] for row in process_rows[trial_key]}),
                          observedProcessCounts=sorted({int(row["processCount"]) for row in rows}),
                          parentAttribution="every observed process reaches the one launched root within its trial")
        for field in ("samples", "medianPrivateMiB", "peakPrivateMiB", "medianWorkingSetMiB", "medianCpuPercentMachine"):
            same(calculated[field], reported_trials[trial_key][field], f"{trial_key}/{field}")
        recomputed.append(calculated)
    summaries = []
    for summary_key, reported in sorted(reported_summary.items()):
        trials = [row for row in recomputed if (row["label"], row["scenario"]) == summary_key]
        require(len(trials) == manifest["trials"], f"Incomplete trials: {summary_key}")
        calculated = dict(label=summary_key[0], scenario=summary_key[1], trials=len(trials))
        for field in ("medianPrivateMiB", "medianWorkingSetMiB", "medianCpuPercentMachine"):
            calculated[field] = statistics.median(row[field] for row in trials)
            same(calculated[field], reported[field], f"{summary_key}/{field}")
        summaries.append(calculated)
    comparisons = []
    for scenario in sorted({row["scenario"] for row in summaries}):
        native = next(row for row in summaries if row["label"] == "winui-native" and row["scenario"] == scenario)
        legacy = next(row for row in summaries if row["label"] == "tauri-baseline" and row["scenario"] == scenario)
        comparisons.append(dict(scenario=scenario,
                                privateBytesChangePercent=(native["medianPrivateMiB"] / legacy["medianPrivateMiB"] - 1) * 100,
                                workingSetSumChangePercent=(native["medianWorkingSetMiB"] / legacy["medianWorkingSetMiB"] - 1) * 100))
    return dict(passed=True, rawSampleRows=len(samples), processSampleRows=len(processes),
                recomputedTrials=recomputed, recomputedSummary=summaries, comparisons=comparisons,
                boundaries=["Private bytes are committed private virtual memory, not physical RAM or VRAM.",
                            "Working-set sum repeats shared pages; it is not unique physical memory.",
                            "Other machine background load was not controlled; this was not an isolated experiment.",
                            "Input idle is not visual or usable-page readiness; authenticated and media flows were not sampled."])


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("folder", type=Path)
    args = parser.parse_args()
    result = audit(args.folder)
    (args.folder / "audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"passed": result["passed"], "rawSampleRows": result["rawSampleRows"],
                      "processSampleRows": result["processSampleRows"], "comparisons": result["comparisons"]}, ensure_ascii=False))
