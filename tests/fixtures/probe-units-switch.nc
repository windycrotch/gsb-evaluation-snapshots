(Acceptance: switch to inches just before probing; physical heights must not move)
(Stock and tools are declared in mm; the G20 comes after cutting, so the machine)
(keeps its physical position and the probe must still meet the mm step at Z-2.)
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
G20                      (switch to inches mid-file, before probing)
G38.2 Z-0.5 F4           (search down in inches; must stop at -2 mm = -0.07874 in)
G0 Z0.2
G38.2 Z-0.5 F4           (same place again: identical contact height)
G0 Z0.2
M2
