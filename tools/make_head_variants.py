#!/usr/bin/env python3
"""Derive print-head presets that differ from the stock PancakeSlicer profile.

Currently: the Bambu Lab A1 mini with the part cooling fan and its duct removed.
On that printer the fan and the duct are one assembly (Bambu FAF006), so without it the
six duct boxes (outlets, outer walls, risers) and the part_cooling_fan box no longer exist.
The stock profile would report hits on those boxes that cannot happen in reality.

The derived files stay inside impasto/heads and inherit the AGPL-3.0 provenance of the source.

Run:  python3 tools/make_head_variants.py
"""
from __future__ import annotations

import json
from pathlib import Path

HEADS = Path(__file__).resolve().parents[1] / "impasto" / "heads"

# A1 mini: part cooling fan + duct as one part -> every box that belongs to it
A1_MINI_DUCT = (
    "left_duct_outlet", "right_duct_outlet",
    "left_duct_outer_wall", "right_duct_outer_wall",
    "left_duct_riser", "right_duct_riser",
)


def derive_no_duct(src: str, dst: str, name: str) -> dict:
    d = json.loads((HEADS / src).read_text())
    boxes = [b for b in d["boxes"] if b.get("name") not in A1_MINI_DUCT and not b.get("duct")]
    dropped = [b.get("name") for b in d["boxes"] if b not in boxes]
    out = dict(d)
    out["id"] = Path(dst).stem
    out["name"] = name
    out["derived_from"] = d["id"]
    out["boxes"] = boxes
    out["provenance"] = (
        d.get("provenance", "") +
        " | Derived locally 2026-11-16 by tools/make_head_variants.py: the part cooling fan and"
        " its duct (one assembly, Bambu FAF006) were removed from the printer, so the boxes"
        f" {', '.join(dropped)} are dropped. Nozzle, heater sock, hotend fan, cover, carriage and"
        " gantry are unchanged."
    )
    cov = dict(d.get("coverage") or {})
    cov.pop("duct_limits", None)
    cov["removed_boxes"] = dropped
    out["coverage"] = cov
    (HEADS / dst).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    return out


def main():
    made = []
    for src, dst, extra in (
        ("bambu-a1-mini.json", "bambu-a1-mini-no-duct.json", ""),
        ("bambu-a1-mini-nozzle-06.json", "bambu-a1-mini-no-duct-nozzle-06.json", "0.6 mm nozzle"),
        ("bambu-a1-mini-nozzle-08.json", "bambu-a1-mini-no-duct-nozzle-08.json", "0.8 mm nozzle"),
    ):
        name = "Bambu Lab A1 mini without part cooling fan" + (f" ({extra})" if extra else "")
        made.append(derive_no_duct(src, dst, name))
    for h in made:
        print(f"{h['id']:42s} {len(h['boxes']):3d} boxes  {h['name']}")


if __name__ == "__main__":
    main()
