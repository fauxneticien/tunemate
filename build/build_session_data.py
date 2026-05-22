#!/usr/bin/env python3
"""
Preprocess TheSession-data CSVs into JSON for the static viewer.

Inputs (default):  tmp/TheSession-data-main/csv/{tunes,aliases,tune_popularity}.csv
Outputs (default): docs/session/{meta.json,search-docs.json,tunes/<id>.json}

Use --limit N to keep only the top N popular tunes (Phase 1 MWE).
"""

import argparse
import csv
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

csv.field_size_limit(sys.maxsize)


def load_popularity(path: Path) -> dict[int, int]:
    pop = {}
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            pop[int(row["tune_id"])] = int(row["tunebooks"])
    return pop


def load_aliases(path: Path, keep_ids: set[int]) -> dict[int, list[str]]:
    by_id = defaultdict(list)
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            tid = int(row["tune_id"])
            if tid not in keep_ids:
                continue
            alias = row["alias"]
            name = row["name"]
            if alias.lower() != name.lower():
                by_id[tid].append(alias)
    return dict(by_id)


def load_tunes(path: Path, keep_ids: set[int]) -> dict[int, dict]:
    """Group settings by tune_id; keep only tunes in keep_ids."""
    tunes: dict[int, dict] = {}
    with path.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            tid = int(row["tune_id"])
            if tid not in keep_ids:
                continue
            if tid not in tunes:
                tunes[tid] = {
                    "tune_id": tid,
                    "name": row["name"],
                    "type": row["type"],
                    "meter": row["meter"],
                    "mode": row["mode"],
                    "settings": [],
                }
            tunes[tid]["settings"].append({
                "setting_id": int(row["setting_id"]),
                "mode": row["mode"],
                "abc": row["abc"],
                "username": row["username"],
                "date": row["date"],
                "composer": row["composer"],
            })
    return tunes


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--data", default="tmp/TheSession-data-main/csv",
                   help="dir containing tunes.csv, aliases.csv, tune_popularity.csv")
    p.add_argument("--out", default="docs",
                   help="output dir (becomes the GitHub Pages root)")
    p.add_argument("--limit", type=int, default=0,
                   help="keep only the top N popular tunes (0 = all)")
    args = p.parse_args()

    data_dir = Path(args.data)
    out_dir = Path(args.out)
    tunes_dir = out_dir / "tunes"
    tunes_dir.mkdir(parents=True, exist_ok=True)

    built_at = datetime.now(timezone.utc).isoformat(timespec="seconds")

    print("Loading popularity…", flush=True)
    pop = load_popularity(data_dir / "tune_popularity.csv")

    if args.limit > 0:
        top = sorted(pop.items(), key=lambda kv: -kv[1])[: args.limit]
        keep_ids = {tid for tid, _ in top}
        print(f"Phase-1 mode: keeping top {len(keep_ids)} by popularity", flush=True)
    else:
        keep_ids = set(pop.keys())
        print(f"Full mode: keeping {len(keep_ids)} tunes that have a popularity record "
              f"(tunes with 0 tunebooks are excluded)", flush=True)

    print("Loading aliases…", flush=True)
    aliases = load_aliases(data_dir / "aliases.csv", keep_ids)

    print("Loading tunes (this is the big one)…", flush=True)
    tunes = load_tunes(data_dir / "tunes.csv", keep_ids)
    print(f"  loaded {len(tunes)} tunes with "
          f"{sum(len(t['settings']) for t in tunes.values())} total settings",
          flush=True)

    print("Writing per-tune JSON…", flush=True)
    for tid, tune in tunes.items():
        (tunes_dir / f"{tid}.json").write_text(
            json.dumps(tune, ensure_ascii=False),
            encoding="utf-8",
        )

    print("Writing meta.json…", flush=True)
    meta = [
        {
            "id": tid,
            "name": tune["name"],
            "type": tune["type"],
            "mode": tune["mode"],
            "n_settings": len(tune["settings"]),
            "pop": pop.get(tid, 0),
        }
        for tid, tune in tunes.items()
    ]
    meta.sort(key=lambda r: -r["pop"])
    (out_dir / "meta.json").write_text(
        json.dumps(meta, ensure_ascii=False),
        encoding="utf-8",
    )

    print("Writing search-docs.json…", flush=True)
    search_docs = [
        {
            "id": tid,
            "name": tune["name"],
            "aliases": aliases.get(tid, []),
            "type": tune["type"],
            "mode": tune["mode"],
        }
        for tid, tune in tunes.items()
    ]
    # Wrapper carries the build timestamp through to search-index.json
    # so the viewer can render "Last built: …" without an extra fetch.
    (out_dir / "search-docs.json").write_text(
        json.dumps({"built_at": built_at, "docs": search_docs}, ensure_ascii=False),
        encoding="utf-8",
    )

    print(f"Done. Wrote {len(tunes)} tune files to {tunes_dir}/ (built_at={built_at})",
          flush=True)


if __name__ == "__main__":
    main()
