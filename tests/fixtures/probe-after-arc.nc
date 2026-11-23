(Acceptance: cut an arc, then probe inside the region the arc's segments covered)
(The probe must see the tessellated arc segments as removed material, not just the)
(straight moves before them.)
(CNCSIM 1 UNITS=mm)
(Stock: XMIN=0 XMAX=60 YMIN=0 YMAX=60 ZMIN=-10 ZMAX=0)
(ToolDef 1: SHAPE=flat D=6)
G21 G90 G17
T1 M6
G0 Z5
G0 X20 Y30
G1 Z-2 F300
G2 X40 Y30 I10 J0 F600   (clockwise semicircle, radius 10, cut at Z-2)
G0 Z5
G0 X30 Y40              (on the arc's path where it reaches the top of the circle)
G38.2 Z-8 F100           (must stop at the arc's Z-2)
G0 Z5
G0 X30 Y20              (the bottom of the circle, not covered by the cut)
G38.2 Z-8 F100           (uncut stock top: Z0)
G0 Z5
M2
