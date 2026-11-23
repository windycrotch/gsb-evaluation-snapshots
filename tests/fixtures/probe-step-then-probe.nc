(Acceptance: cut a step, then probe straight down onto the machined step)
(CNCSIM 1 UNITS=mm)
(Stock: XMIN=0 XMAX=60 YMIN=0 YMAX=60 ZMIN=-10 ZMAX=0)
(ToolDef 1: SHAPE=flat D=6)
G21 G90 G17
T1 M6
G0 Z5
G0 X18 Y18
G1 Z-2 F300          (plunge to the step floor)
(raster the 20..40 x 20..40 step at Z-2)
G1 X42 F900
G1 Y23
G1 X18
G1 Y26
G1 X42
G1 Y29
G1 X18
G1 Y32
G1 X42
G1 Y35
G1 X18
G1 Y38
G1 X42
G1 Y42
G1 X18
G0 Z5
G0 X30 Y30           (over the machined step floor)
G38.2 Z-8 F100       (must stop at Z-2, not the uncut top)
G0 Z5
G0 X10 Y10           (over uncut stock)
G38.2 Z-8 F100       (must stop at Z0)
G0 Z5
M2
