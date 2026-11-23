(Acceptance: a G38.2 with nothing to touch alarms, writes no fake contact point,)
(leaves the surface untouched, and two probes at the same place touch the same height.)
(CNCSIM 1 UNITS=mm)
(Stock: XMIN=0 XMAX=60 YMIN=0 YMAX=60 ZMIN=-10 ZMAX=0)
(ToolDef 1: SHAPE=flat D=6)
G21 G90 G17
T1 M6
G0 Z5
G0 X20 Y20
G1 Z-2 F300
G1 X40
G0 Z5
G0 X30 Y20
G38.2 Z0.5 F100          (target above the step floor: never reaches it, must alarm)
G0 Z5
G38.2 Z-8 F100           (same place again: must touch the step at Z-2, like the first)
G0 Z5
G38.2 Z-8 F100           (and again: second contact height equals the first)
G0 Z5
M2
