(Acceptance: probe a P touch plate, then keep cutting with the updated offset)
(The probe over uncut stock touches the plate top, sets work Z so it reads P,)
(and the following cut uses that offset.)
(CNCSIM 1 UNITS=mm)
(Stock: XMIN=0 XMAX=60 YMIN=0 YMAX=60 ZMIN=-10 ZMAX=0)
(ToolDef 1: SHAPE=flat D=6)
G21 G90 G17
T1 M6
G0 Z5
G0 X20 Y20
G38.2 Z-8 P2 F100        (plate 2 mm thick on the stock top, sets Z so contact reads 2)
G0 Z12
G1 Z2 F300               (a cut AT the probed plate top: physical Z = 2 + offset)
G1 X40
G0 Z5
M2
