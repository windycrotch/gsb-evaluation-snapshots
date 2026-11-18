"""AMS mapping: every used filament must get a tray, the external spool is never used."""
from impasto import printer

TRAYS = [
    {"slot": 0, "type": "PHA", "color": "#FFFFFF", "remain": 100},
    {"slot": 1, "type": "PLA", "color": "#FFF144", "remain": 100},
    {"slot": 2, "type": "PHA", "color": "#161616", "remain": 100},
    {"slot": 3, "type": "PHA", "color": "#FCECD6", "remain": 100},
]
COLORS = ["#FFFFFF", "#FFF144", "#161616", "#FCECD6"]
TYPES = ["PHA", "PLA", "PHA", "PHA"]


def test_exact_match():
    mm = printer.match_mapping(COLORS, TYPES, [0, 1, 2, 3], TRAYS)
    assert mm["ok"]
    assert mm["mapping"] == [0, 1, 2, 3]
    assert all("differ" not in n for n in mm["notes"])


def test_single_filament_from_ams():
    mm = printer.match_mapping(COLORS, TYPES, [1], TRAYS)
    assert mm["mapping"] == [-1, 1, -1, -1]


def test_colour_only_match_is_flagged():
    trays = [{"slot": 0, "type": "PETG", "color": "#FFFFFF", "remain": 50}]
    mm = printer.match_mapping(["#FFFFFF"], ["PHA"], [0], trays)
    assert mm["ok"] and mm["mapping"][0] == 0
    assert "material" in mm["notes"][0]


def test_unknown_filament_still_takes_a_tray():
    trays = [{"slot": 2, "type": "PETG", "color": "#0000FF", "remain": 40}]
    mm = printer.match_mapping(["#ABCDEF"], ["ABS"], [0], trays)
    assert mm["ok"] and mm["mapping"][0] == 2          # never -1 -> never the external spool
    assert "differ" in mm["notes"][0]


def test_two_equal_colours_get_two_trays():
    trays = [{"slot": 0, "type": "PHA", "color": "#FFFFFF", "remain": 90},
             {"slot": 3, "type": "PHA", "color": "#FFFFFF", "remain": 90}]
    mm = printer.match_mapping(["#FFFFFF", "#FFFFFF"], ["PHA", "PHA"], [0, 1], trays)
    assert mm["ok"]
    assert mm["mapping"][:2] == [0, 3]


def test_empty_tray_is_the_last_resort():
    trays = [{"slot": 0, "type": "PHA", "color": "#FFFFFF", "remain": 0},
             {"slot": 1, "type": "PHA", "color": "#FFFFFF", "remain": 80},
             {"slot": 2, "type": "PHA", "color": "#161616", "remain": 80}]
    mm = printer.match_mapping(["#FFFFFF", "#161616"], ["PHA", "PHA"], [0, 1], trays)
    assert mm["mapping"][:2] == [1, 2]                 # never the empty tray while a full one fits


def test_more_filaments_than_trays_is_refused():
    mm = printer.match_mapping(COLORS, TYPES, [0, 1, 2, 3], TRAYS[:2])
    assert not mm["ok"]
    assert "only 2 in the AMS" in mm["error"]


def test_ams_messages_follow_the_request_language():
    from impasto.i18n import LANG
    token = LANG.set("de")
    try:
        assert "2 im AMS" in printer.match_mapping(COLORS, TYPES, [0, 1, 2, 3], TRAYS[:2])["error"]
    finally:
        LANG.reset(token)


def test_no_ams_is_refused():
    mm = printer.match_mapping(COLORS, TYPES, [0], [])
    assert not mm["ok"]
    assert "AMS" in mm["error"]


def test_unused_slots_stay_unmapped():
    mm = printer.match_mapping(COLORS, TYPES, [2], TRAYS)
    assert mm["ok"]
    assert mm["mapping"] == [-1, -1, 2, -1]


def test_mapping_covers_high_filament_index():
    mm = printer.match_mapping(COLORS + ["#111111", "#222222"], TYPES + ["PHA", "PHA"],
                               [5], TRAYS)
    assert len(mm["mapping"]) == 6
    assert mm["mapping"][5] >= 0


FULL = {"ams": {"tray_now": "2", "ams": [{"id": "0", "humidity": "5", "tray": [
    {"id": str(i), "tray_type": "PHA", "tray_color": c, "remain": 100}
    for i, c in enumerate(["FCECD6FF", "FFFFFFFF", "161616FF", "FF0000FF"])]}]}}


def _full():
    import copy
    rep = {}
    printer.merge_report(rep, copy.deepcopy(FULL))
    return rep


def test_partial_ams_update_keeps_trays():
    rep = _full()
    printer.merge_report(rep, {"ams": {"tray_now": "1"}})              # no unit list
    printer.merge_report(rep, {"ams": {"ams": [{"id": "0", "humidity": "4"}]}})  # no trays
    u = rep["ams"]["ams"][0]
    assert rep["ams"]["tray_now"] == "1" and u["humidity"] == "4"
    assert [t["tray_color"] for t in u["tray"]] == ["FCECD6FF", "FFFFFFFF", "161616FF", "FF0000FF"]


def test_single_tray_update_is_merged():
    rep = _full()
    printer.merge_report(rep, {"ams": {"ams": [{"id": "0", "tray": [{"id": "2", "remain": 37}]}]}})
    t = rep["ams"]["ams"][0]["tray"]
    assert len(t) == 4 and t[2]["remain"] == 37 and t[2]["tray_type"] == "PHA"


def test_emptied_tray_overwrites():
    rep = _full()
    printer.merge_report(rep, {"ams": {"ams": [{"id": "0", "tray": [{"id": "3", "tray_type": ""}]}]}})
    assert rep["ams"]["ams"][0]["tray"][3]["tray_type"] == ""


def test_trays_fall_back_to_last_full_ams(monkeypatch):
    class Fake:
        report = {"ams": {"tray_now": "1"}}                            # after reconnect
        ams_good = (printer.time.time(), FULL["ams"])
        lock = printer.threading.Lock()

        def status(self, *a, **k):
            return {}

        def wait(self, *a, **k):
            return True

        def _connect(self, *a, **k):
            raise AssertionError("no reconnect while a recent full AMS is known")

    monkeypatch.setattr(printer, "_printer", Fake())
    assert len(printer.trays("1.2.3.4", "code", "SERIAL")) == 4


def test_ams_report_parsing(monkeypatch):
    rep = {"ams": {"ams": [{"id": "0", "tray": [
        {"id": "0", "tray_type": "PHA", "tray_color": "FFFFFFFF", "remain": 100},
        {"id": "1", "tray_type": "", "tray_color": "00000000"},
        {"id": "2", "tray_type": "PHA", "tray_color": "161616FF", "remain": 42},
    ]}]}}

    class Fake:
        report = rep

        def status(self, *a, **k):
            return {}

        def wait(self, *a, **k):
            return True

        lock = printer.threading.Lock()

    monkeypatch.setattr(printer, "_printer", Fake())
    out = printer.trays("1.2.3.4", "code", "SERIAL")
    assert out == [{"slot": 0, "type": "PHA", "color": "#FFFFFF", "remain": 100},
                   {"slot": 2, "type": "PHA", "color": "#161616", "remain": 42}]
