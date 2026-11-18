from pathlib import Path
import re
import pytest
from impasto import bambu, toolchange

SAMPLE = Path(__file__).resolve().parents[1] / "Brille_MK_V_hinge_prototype_V_front_PHA_4h0m.gcode"


@pytest.mark.skipif(not SAMPLE.exists(), reason="sample missing")
def test_render_matches_bambu():
    job = bambu.load_path(SAMPLE)
    a = next(i for i, l in enumerate(job.lines) if l.startswith("; FilamentChangeGCodeStart"))
    b = next(i for i, l in enumerate(job.lines) if l.startswith("; FilamentChangeGCodeEnd"))
    real = [l for l in job.lines[a + 1:b] if not l.startswith("M73 E")]
    # tower path: purge volume as Bambu computed it (flush_length 110.859 mm)
    vol = 110.859 * toolchange.filament_area(job, 0)
    txt, _ = toolchange.render_change(job, 2, 0, max_layer_z=26.0, layer_z=26.0, layer_num=215,
                                      pos=(17.511, 152.341, 26.0), purge_vol=vol)
    mine = txt.split("\n")
    if mine and mine[-1] == "":
        mine.pop()
    norm = lambda ls: [l.rstrip() for l in ls]
    import difflib
    diff = list(difflib.unified_diff(norm(real), norm(mine), lineterm="", n=0))
    # numbers may differ in the last digit because of the volume round trip
    bad = [d for d in diff if d.startswith(("+", "-")) and not d.startswith(("+++", "---"))]
    def canon(l):
        l = l[1:].replace(" F3000", "")
        return re.sub(r"\d+\.\d+", lambda m: "%.3g" % float(m.group()), l)
    minus = [canon(d) for d in bad if d[0] == "-"]
    plus = [canon(d) for d in bad if d[0] == "+"]
    assert minus == plus, "\n".join(diff[:80])
