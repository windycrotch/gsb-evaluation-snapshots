; Layer / tool / rapid visibility test file for the 3D renderer.
; Each Z level is a separate rectangle at a different place, so a filtered-out layer is
; visible at a glance. T1 cuts three levels, T2 cuts two, with G0 moves between them.
G21
G90
G17
G94

T1 M6
S10000 M3
G0 X0 Y0 Z5
; T1 z=-1
G0 X10 Y10
G1 Z-1 F300
G1 X60 Y10 F1200
G1 X60 Y40
G1 X10 Y40
G1 X10 Y10
; T1 z=-2
G0 Z5
G0 X70 Y10
G1 Z-2 F300
G1 X120 Y10 F1200
G1 X120 Y40
G1 X70 Y40
G1 X70 Y10
; T1 z=-3
G0 Z5
G0 X130 Y10
G1 Z-3 F300
G1 X180 Y10 F1200
G1 X180 Y40
G1 X130 Y40
G1 X130 Y10
G0 Z5

T2 M6
; T2 z=-1
G0 X10 Y80
G1 Z-1 F300
G1 X60 Y80 F900
G1 X60 Y110
G1 X10 Y110
G1 X10 Y80
; T2 z=-2
G0 Z5
G0 X100 Y80
G1 Z-2 F300
G1 X150 Y80 F900
G1 X150 Y110
G1 X100 Y110
G1 X100 Y80
G0 Z5
M5
M30
